import type { AccountRepository } from '../../infrastructure/database/account-repository'
import type { AccountManager } from '../../plugin/accounts'
import * as logger from '../../plugin/logger'
import { kiroDb } from '../../plugin/storage/sqlite'
import type { ManagedAccount } from '../../plugin/types'
import { summarizeUsage } from '../../plugin/usage'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

interface AccountSelectorConfig {
  auto_sync_kiro_cli: boolean
  account_selection_strategy: 'sticky' | 'round-robin' | 'lowest-usage'
}

export class AccountSelector {
  private triedEmptySync = false
  private circuitBreakerTrips = 0
  private lastCircuitBreakerReset = Date.now()

  constructor(
    private accountManager: AccountManager,
    private config: AccountSelectorConfig,
    private syncFromKiroCli: () => Promise<void>,
    private repository: AccountRepository
  ) {}

  /**
   * Pick an account to serve this request.
   *
   * A session sticks to the account that first served it. A conversationId is
   * only valid on the account that created it, so a pool rotating mid-session
   * makes the service reject the id and the conversation restarts — which is
   * what the "stale conversationId" retries were. The pin is advisory: an
   * unhealthy or rate-limited account falls through to normal selection and
   * the session is re-pinned to whoever answers.
   */
  async selectHealthyAccount(
    showToast: ToastFunction,
    sessionId?: string
  ): Promise<ManagedAccount | null> {
    this.checkCircuitBreaker()

    const pinned = sessionId ? this.pinnedAccount(sessionId) : null
    if (pinned) {
      this.resetCircuitBreaker()
      return pinned
    }

    let count = this.accountManager.getAccountCount()

    if (count === 0 && this.config.auto_sync_kiro_cli && !this.triedEmptySync) {
      this.triedEmptySync = true
      await this.handleEmptyAccounts()
      count = this.accountManager.getAccountCount()
    }

    if (count === 0) {
      throw new Error('No accounts')
    }

    let acc = this.accountManager.getCurrentOrNext()

    if (!acc) {
      this.circuitBreakerTrips++
      const wait = this.accountManager.getMinWaitTime()
      if (wait > 0 && wait < 30000) {
        if (this.accountManager.shouldShowToast()) {
          showToast(`All accounts rate-limited. Waiting ${Math.ceil(wait / 1000)}s...`, 'warning')
        }
        await this.sleep(wait)
        return null
      }
      throw new Error('All accounts are unhealthy or rate-limited: reauth required')
    }

    this.resetCircuitBreaker()
    if (sessionId) this.pinAccount(sessionId, acc.id)

    const used = acc.usedCount ?? 0
    const limit = acc.limitCount ?? 0
    if (limit > 0 && used / limit >= 0.9 && this.accountManager.shouldShowUsageToast()) {
      showToast(this.formatUsageMessage(used, limit, acc.email || ''), 'warning')
    }

    return acc
  }

  private pinnedAccount(sessionId: string): ManagedAccount | null {
    let accountId: string | undefined
    try {
      accountId = kiroDb.getSessionAccount(sessionId)
    } catch {
      // The store is optional; without it every request just selects normally.
      return null
    }
    if (!accountId) return null

    const acc = this.accountManager.getUsableById(accountId)
    if (!acc) {
      logger.debug(`[AFFINITY] ${sessionId} pinned account unusable, reselecting`)
      return null
    }
    return acc
  }

  private pinAccount(sessionId: string, accountId: string): void {
    try {
      kiroDb.setSessionAccount(sessionId, accountId)
    } catch (e) {
      logger.debug(`[AFFINITY] could not pin (${e instanceof Error ? e.message : e})`)
    }
  }

  private async handleEmptyAccounts(): Promise<void> {
    await this.syncFromKiroCli()
    this.repository.invalidateCache()
    const accounts = await this.repository.findAll()
    for (const a of accounts) {
      await this.accountManager.addAccount(a)
    }
  }

  private formatUsageMessage(usedCount: number, limitCount: number, email: string): string {
    const { used, limit, pct } = summarizeUsage(usedCount, limitCount)
    return limit > 0 ? `Usage (${email}): ${used}/${limit} (${pct}%)` : `Usage (${email}): ${used}`
  }

  private checkCircuitBreaker(): void {
    if (Date.now() - this.lastCircuitBreakerReset > 60000) {
      this.circuitBreakerTrips = 0
      this.lastCircuitBreakerReset = Date.now()
    }

    if (this.circuitBreakerTrips >= 10) {
      throw new Error('Circuit breaker tripped: Too many consecutive failures selecting accounts')
    }
  }

  private resetCircuitBreaker(): void {
    if (this.circuitBreakerTrips > 0) {
      this.circuitBreakerTrips = 0
      this.lastCircuitBreakerReset = Date.now()
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }
}
