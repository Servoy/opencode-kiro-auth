import type { AccountRepository } from '../../infrastructure/database/account-repository'
import type { AccountManager } from '../../plugin/accounts'
import { isPermanentError } from '../../plugin/health'
import * as logger from '../../plugin/logger'
import { kiroDb } from '../../plugin/storage/sqlite'
import type { KiroAuthDetails, ManagedAccount } from '../../plugin/types'
import { fetchUsageLimits, updateAccountQuota, type UsageResult } from '../../plugin/usage'
import { quotaInfoFromUsage, writeUsageSnapshot } from '../../plugin/usage-snapshot'

interface UsageTrackerConfig {
  usage_tracking_enabled: boolean
  usage_sync_max_retries: number
  usage_sync_cooldown_ms?: number
}

export class UsageTracker {
  private lastSyncTime = new Map<string, number>()
  private readonly cooldownMs: number

  constructor(
    private config: UsageTrackerConfig,
    private accountManager: AccountManager,
    private repository: AccountRepository
  ) {
    this.cooldownMs = config.usage_sync_cooldown_ms ?? 60000
  }

  async syncUsage(account: ManagedAccount, auth: KiroAuthDetails): Promise<void> {
    if (!this.config.usage_tracking_enabled) return

    const last = this.lastSyncTime.get(account.id) ?? 0
    if (Date.now() - last < this.cooldownMs) return

    this.lastSyncTime.set(account.id, Date.now())
    this.syncWithRetry(account, auth, 0).catch((e) => {
      logger.warn('Usage sync failed after all retries', {
        accountId: account.id,
        error: e instanceof Error ? e.message : String(e)
      })
    })
  }

  // Fetch usage once and persist it, bypassing the cooldown/retry loop. Used by
  // the startup refresh, where the caller handles token refresh and fallback.
  async syncNow(account: ManagedAccount, auth: KiroAuthDetails): Promise<void> {
    const u = await fetchUsageLimits(auth)
    updateAccountQuota(account, u, this.accountManager)
    // Stored before the snapshot so this write and every later one, from any
    // instance, render the same reset date and plan.
    try {
      kiroDb.saveQuotaInfo(account.id, quotaInfoFromUsage(u))
    } catch (e) {
      logger.warn('Quota details not stored (non-fatal)', {
        error: e instanceof Error ? e.message : String(e)
      })
    }
    this.writeSnapshot(account, u)

    // Single-row usage write, not a full-table batchSave merge: a sync only
    // changes this account's counters, and at 15 projects the per-minute merge
    // was needless file-lock traffic. invalidateCache keeps findAll fresh.
    await kiroDb.updateAccountUsage({
      id: account.id,
      usedCount: account.usedCount ?? 0,
      limitCount: account.limitCount ?? 0,
      lastSync: Date.now(),
      overageEnabled: account.overageEnabled
    })
    try {
      kiroDb.recordUsageReading(account.id, account.usedCount ?? 0)
    } catch (e) {
      logger.warn('Usage counter reading not recorded (non-fatal)', {
        error: e instanceof Error ? e.message : String(e)
      })
    }
    this.repository.invalidateCache()
  }

  /**
   * Refresh the panel snapshot with the fresh account usage.
   *
   * Session credits are no longer derived here: each response books its own
   * metered credits as it ends (RequestHandler.recordMeteredCredits). Isolated
   * so a snapshot hiccup never fails the usage sync itself.
   *
   * @param account the account just synced
   * @param usage the getUsageLimits result for it
   */
  private writeSnapshot(account: ManagedAccount, usage: UsageResult): void {
    try {
      const usageById = new Map<string, UsageResult>([[account.id, usage]])
      writeUsageSnapshot(this.accountManager.getAccounts(), usageById)
    } catch (e) {
      logger.warn('Usage snapshot after sync skipped (non-fatal)', {
        error: e instanceof Error ? e.message : String(e)
      })
    }
  }

  private async syncWithRetry(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    attempt: number
  ): Promise<void> {
    try {
      await this.syncNow(account, auth)
    } catch (e: any) {
      const msg = e?.message || ''

      // Don't retry rate-limit errors — that just amplifies the problem.
      const isRateLimit =
        msg.includes('429') ||
        msg.includes('ThrottlingException') ||
        msg.includes('TooManyRequests')

      if (!isRateLimit && attempt < this.config.usage_sync_max_retries) {
        await this.sleep(1000 * Math.pow(2, attempt))
        return this.syncWithRetry(account, auth, attempt + 1)
      }

      if (msg.includes('FEATURE_NOT_SUPPORTED')) {
        // Some IDC profiles don't expose getUsageLimits — not an error.
        return
      }

      if (isRateLimit) {
        // Don't penalize the account; the request flow has its own 429 handler.
        logger.warn('Usage sync rate-limited; skipping until next cooldown', {
          accountId: account.id
        })
        return
      }

      if (isPermanentError(msg)) {
        await this.accountManager.markUnhealthy(account, msg)
        this.repository.save(account).catch(() => {})
      }

      throw e
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }
}
