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

export class TokenRefresher {
  constructor(
    private config: TokenRefresherConfig,
    private accountManager: AccountManager,
    private syncFromKiroCli: () => Promise<void>,
    private repository: AccountRepository
  ) {}

  async refreshIfNeeded(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    showToast: ToastFunction
  ): Promise<{ account: ManagedAccount; shouldContinue: boolean }> {
    if (!accessTokenExpired(auth, this.config.token_expiry_buffer_ms)) {
      return { account, shouldContinue: false }
    }

    // Retry transient failures (network blips, brief AWS SSO unavailability)
    // before escalating to handleRefreshError. Permanent auth failures skip
    // the retry — they're never going to succeed via refresh.
    const maxAttempts = 3
    let lastError: any
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const newAuth = await refreshAccessToken(auth)
        await this.accountManager.updateFromAuth(account, newAuth)
        await this.repository.save(account)
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
      return true
    }

    try {
      const newAuth = await refreshAccessToken(auth)
      await this.accountManager.updateFromAuth(account, newAuth)

      if (account.accessToken === previousToken) {
        logger.warn('Force refresh: OIDC returned an unchanged access token')
        await this.markRefreshFailed(account, 'unauthorized: refresh returned unchanged token')
        return false
      }

      logger.warn('Force refresh: token refreshed via OIDC')
      return true
    } catch (e: any) {
      const message = e instanceof Error ? e.message : String(e)
      logger.warn('Force refresh failed after bearer-403', { message })
      await this.markRefreshFailed(account, e?.code || message)
      return false
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
        error.message.includes('Invalid refresh token provided') ||
        error.message.includes('Invalid grant provided') ||
        error.message.includes('Client is expired'))
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
