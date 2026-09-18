import type { AccountRepository } from '../../infrastructure/database/account-repository'
import type { AccountManager } from '../../plugin/accounts'
import { isPermanentError } from '../../plugin/health'
import * as logger from '../../plugin/logger'
import { kiroDb } from '../../plugin/storage/sqlite'
import type { KiroAuthDetails, ManagedAccount } from '../../plugin/types'
import { fetchUsageLimits, updateAccountQuota, type UsageResult } from '../../plugin/usage'
import { writeUsageSnapshot } from '../../plugin/usage-snapshot'

interface UsageTrackerConfig {
  usage_tracking_enabled: boolean
  usage_sync_max_retries: number
  usage_sync_cooldown_ms?: number
}

export class UsageTracker {
  private lastSyncTime = new Map<string, number>()
  /** When each account's credits were last apportioned, so the next delta window starts there. */
  private lastSyncAtByAccount = new Map<string, number>()
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
    const previousUsed = account.usedCount ?? 0
    const u = await fetchUsageLimits(auth)
    updateAccountQuota(account, u, this.accountManager)

    // Attribute the credits spent since the last sync to the sessions that ran
    // in that window, then refresh the panel snapshot with the full response.
    this.attributeAndSnapshot(account, u, previousUsed)

    await this.repository.batchSave(this.accountManager.getAccounts())
  }

  /**
   * Apportion the credit delta to recent sessions and write the panel snapshot.
   *
   * Isolated so a store hiccup here never fails the usage sync itself — the
   * account quota is already updated by the time this runs. `previousUsed` is
   * captured before the fetch so the delta reflects only this interval.
   */
  private attributeAndSnapshot(
    account: ManagedAccount,
    usage: UsageResult,
    previousUsed: number
  ): void {
    try {
      const delta = (usage.usedCount ?? 0) - previousUsed
      const since = this.lastSyncAtByAccount.get(account.id) ?? 0
      if (delta > 0) kiroDb.apportionSessionCredits(account.id, delta, since)
      this.lastSyncAtByAccount.set(account.id, Date.now())

      const usageById = new Map<string, UsageResult>([[account.id, usage]])
      writeUsageSnapshot(this.accountManager.getAccounts(), usageById)
    } catch (e) {
      logger.debug(
        `Usage attribution/snapshot skipped: ${e instanceof Error ? e.message : String(e)}`
      )
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
