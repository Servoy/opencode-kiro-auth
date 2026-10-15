import type { AccountRepository } from '../../infrastructure/database/account-repository'
import { accessTokenExpired } from '../../kiro/auth'
import type { AccountManager } from '../../plugin/accounts'
import { KiroTokenRefreshError } from '../../plugin/errors'
import { isPermanentError, isTransientNetworkError } from '../../plugin/health'
import * as logger from '../../plugin/logger'
import { refreshAccessToken } from '../../plugin/token'
import type { KiroAuthDetails, ManagedAccount } from '../../plugin/types'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

interface TokenRefresherConfig {
  token_expiry_buffer_ms: number
  auto_sync_kiro_cli: boolean
  account_selection_strategy: 'sticky' | 'round-robin' | 'lowest-usage'
}

type RefreshOutcome = { account: ManagedAccount; shouldContinue: boolean }

/**
 * What one attempt to obtain a newer access token produced.
 *
 * `refreshed` is the only success. `unchanged` and `rejected` mean the token is
 * unusable, `offline` that nobody knows — the caller's business.
 */
type RefreshExchange =
  | { outcome: 'refreshed' }
  | { outcome: 'unchanged' }
  | { outcome: 'offline'; message: string }
  | { outcome: 'rejected'; reason: string }

export class TokenRefresher {
  /**
   * One in-flight refresh per account id, shared across every session in this
   * process. One account has one token with one expiry, so without this all
   * sessions that see it lapse stampede the OIDC endpoint (and the db write
   * each refresh does) at once. Static to span every per-session RequestHandler.
   */
  private static inFlightByAccount = new Map<string, Promise<RefreshOutcome>>()

  constructor(
    private config: TokenRefresherConfig,
    private accountManager: AccountManager,
    private syncFromKiroCli: () => Promise<void>,
    private repository: AccountRepository
  ) {}

  /**
   * Join a refresh already running for this account rather than starting a
   * second. The map entry is cleared once the refresh settles, so the next
   * genuine expiry starts a fresh one instead of resolving from a stale hit.
   */
  private coalesceRefresh(
    account: ManagedAccount,
    refresh: () => Promise<RefreshOutcome>
  ): Promise<RefreshOutcome> {
    const existing = TokenRefresher.inFlightByAccount.get(account.id)
    if (existing) return existing

    const inFlight = refresh().finally(() => {
      TokenRefresher.inFlightByAccount.delete(account.id)
    })
    TokenRefresher.inFlightByAccount.set(account.id, inFlight)
    return inFlight
  }

  async refreshIfNeeded(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    showToast: ToastFunction
  ): Promise<RefreshOutcome> {
    if (!accessTokenExpired(auth, this.config.token_expiry_buffer_ms)) {
      return { account, shouldContinue: false }
    }

    return this.coalesceRefresh(account, () => this.doRefresh(account, auth, showToast))
  }

  private async doRefresh(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    showToast: ToastFunction
  ): Promise<RefreshOutcome> {
    // Transient failures (network blips, brief SSO unavailability) are retried;
    // permanent auth failures skip straight to handleRefreshError.
    const maxAttempts = 3
    let lastError: any
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const newAuth = await refreshAccessToken(auth)
        // updateFromAuth already persists the row; a second repository.save()
        // duplicates a full-table write under the same lock.
        await this.accountManager.updateFromAuth(account, newAuth)
        this.repository.invalidateCache()
        return { account, shouldContinue: false }
      } catch (e: any) {
        lastError = e
        if (isPermanentError(e?.message) || isPermanentError(e?.code) || attempt === maxAttempts)
          break
        await this.sleep(1000 * Math.pow(2, attempt - 1))
      }
    }
    return await this.handleRefreshError(lastError, account, showToast)
  }

  /**
   * Replace the account's access token after a bearer-403.
   *
   * Returns true only when the account ends up holding a genuinely new token.
   * On failure it is marked unhealthy so callers escalate to rotation or
   * reauth instead of retrying a dead token. Every outcome logs at warn: this
   * is the escalation path, and silence here is indistinguishable from a hang.
   */
  async forceRefresh(account: ManagedAccount, auth: KiroAuthDetails): Promise<boolean> {
    // A rejected key has nothing to refresh and nothing in the CLI to recover from.
    if (account.authMethod === 'apikey') {
      logger.warn('Force refresh: API key rejected by Kiro', { email: account.email })
      await this.markRefreshFailed(account, 'API key rejected by Kiro')
      return false
    }

    const outcome = await this.coalesceRefresh(account, async () => {
      const exchange = await this.exchangeRefreshToken(account, auth)
      await this.disableAccountIfRejected(account, exchange)
      return { account, shouldContinue: exchange.outcome !== 'refreshed' }
    })
    return !outcome.shouldContinue
  }

  /**
   * Trade the account's access token for a fresh one without touching its health.
   *
   * For callers with no authority over the credential — context-window discovery
   * runs beside a request, not as part of one — so a failure there cannot sign a
   * working user out mid-conversation.
   */
  async refreshPreservingAccountHealth(
    account: ManagedAccount,
    auth: KiroAuthDetails
  ): Promise<boolean> {
    const outcome = await this.coalesceRefresh(account, async () => {
      const exchange = await this.exchangeRefreshToken(account, auth)
      return { account, shouldContinue: exchange.outcome !== 'refreshed' }
    })
    return !outcome.shouldContinue
  }

  /**
   * Disable the account when the exchange proved its credential dead.
   *
   * A transport failure or an offline moment proves nothing, so it leaves the
   * account alone — only an unchanged or explicitly rejected token does.
   */
  private async disableAccountIfRejected(
    account: ManagedAccount,
    exchange: RefreshExchange
  ): Promise<void> {
    if (exchange.outcome === 'unchanged') {
      await this.markRefreshFailed(account, 'unauthorized: refresh returned unchanged token')
    } else if (exchange.outcome === 'rejected') {
      await this.markRefreshFailed(account, exchange.reason)
    }
  }

  /**
   * Get a newer access token, reporting what happened rather than what to do
   * about it: marking the account unhealthy is the caller's policy, not this
   * method's. Every caller wants the same trade, only the consequence differs.
   */
  private async exchangeRefreshToken(
    account: ManagedAccount,
    auth: KiroAuthDetails
  ): Promise<RefreshExchange> {
    const previousToken = account.accessToken

    if (this.config.auto_sync_kiro_cli) {
      await this.syncFromKiroCli()
    }

    this.repository.invalidateCache()
    const accounts = await this.repository.findAll()
    const synced = accounts.find((a: ManagedAccount) => a.id === account.id)

    if (synced && synced.accessToken && synced.accessToken !== previousToken) {
      await this.accountManager.updateFromAuth(account, this.accountManager.toAuthDetails(synced))
      logger.warn('Force refresh: recovered newer token from CLI sync')
      return { outcome: 'refreshed' }
    }

    try {
      const newAuth = await refreshAccessToken(auth)
      await this.accountManager.updateFromAuth(account, newAuth)

      if (account.accessToken === previousToken) {
        logger.warn('Force refresh: OIDC returned an unchanged access token')
        return { outcome: 'unchanged' }
      }

      logger.warn('Force refresh: token refreshed via OIDC')
      return { outcome: 'refreshed' }
    } catch (e: any) {
      const message = e instanceof Error ? e.message : String(e)
      // A dropped connection says nothing about the credentials. Reporting it as
      // a rejection would turn a laptop that slept mid-request into a forced
      // sign-in, so a transport failure stays its own outcome.
      if (isTransientNetworkError(message) || isTransientNetworkError(e?.code)) {
        logger.warn('Force refresh: no connectivity, token left as it was', {
          email: account.email,
          message
        })
        return { outcome: 'offline', message }
      }
      logger.warn('Force refresh failed after bearer-403', { message })
      return { outcome: 'rejected', reason: e?.code || message }
    }
  }

  // Mark permanent so the request loop escalates to reauth instead of retrying a
  // dead token. Prefix with 'unauthorized' (which isPermanentError matches).
  private async markRefreshFailed(account: ManagedAccount, reason: string): Promise<void> {
    const permanentReason = isPermanentError(reason) ? reason : `unauthorized: ${reason}`
    try {
      await this.accountManager.markUnhealthy(account, permanentReason)
    } catch (e) {
      logger.warn('markRefreshFailed: markUnhealthy failed', {
        message: e instanceof Error ? e.message : String(e)
      })
    }
  }

  private async handleRefreshError(
    error: any,
    account: ManagedAccount,
    showToast: ToastFunction
  ): Promise<{ account: ManagedAccount; shouldContinue: boolean }> {
    logger.error('Token refresh failed', {
      email: account.email,
      code: error instanceof KiroTokenRefreshError ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error)
    })
    if (this.config.auto_sync_kiro_cli) {
      await this.syncFromKiroCli()
    }

    this.repository.invalidateCache()
    const accounts = await this.repository.findAll()
    const stillAcc = accounts.find((a: ManagedAccount) => a.id === account.id)

    if (
      stillAcc &&
      !accessTokenExpired(
        this.accountManager.toAuthDetails(stillAcc),
        this.config.token_expiry_buffer_ms
      )
    ) {
      showToast('Credentials recovered from Kiro CLI sync.', 'info')
      return { account: stillAcc, shouldContinue: true }
    }

    if (
      error instanceof KiroTokenRefreshError &&
      (error.code === 'ExpiredTokenException' ||
        error.code === 'InvalidTokenException' ||
        error.code === 'ExpiredClientException' ||
        error.code === 'HTTP_401' ||
        error.code === 'HTTP_403' ||
        isPermanentError(error.code) ||
        isPermanentError(error.message))
    ) {
      await this.accountManager.markUnhealthy(account, error.code || error.message)
      return { account, shouldContinue: true }
    }

    const message = error instanceof Error ? error.message : String(error)

    if (isTransientNetworkError(message) || isTransientNetworkError(error?.code)) {
      logger.warn('Token refresh: no connectivity, will retry', {
        email: account.email,
        message
      })
      showToast('Kiro sign-in could not be refreshed — no connection. Retrying.', 'warning')
      return { account, shouldContinue: true }
    }

    logger.error('Token refresh unrecoverable', {
      email: account.email,
      code: error instanceof KiroTokenRefreshError ? error.code : undefined,
      message
    })
    throw error
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
