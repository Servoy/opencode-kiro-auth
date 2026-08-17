import type { AccountRepository } from '../../infrastructure/database/account-repository'
import type { AccountManager } from '../../plugin/accounts'
import * as logger from '../../plugin/logger'
import type { ManagedAccount } from '../../plugin/types'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

interface RequestContext {
  retry: number
  bearerRetried?: boolean
  // Time spent in rate-limit sleeps, propagated up so the retry strategy can
  // exclude it from the request timeout budget.
  excludedMs?: number
}

interface ErrorHandlerConfig {
  rate_limit_max_retries: number
  rate_limit_retry_delay_ms: number
}

export class ErrorHandler {
  constructor(
    private config: ErrorHandlerConfig,
    private accountManager: AccountManager,
    private repository: AccountRepository
  ) {}

  async handle(
    error: any,
    response: Response,
    account: ManagedAccount,
    context: RequestContext,
    showToast: ToastFunction,
    model?: string
  ): Promise<{
    shouldRetry: boolean
    newContext?: RequestContext
    switchAccount?: boolean
    forceRefresh?: boolean
  }> {
    const readBody = async (): Promise<string> => {
      try {
        const body = JSON.parse(await response.clone().text())
        return body.message || body.Message || body.__type || JSON.stringify(body)
      } catch {
        return ''
      }
    }

    if (response.status === 400) {
      const reason = await readBody()
      const message = this.enrichIfInvalidModel(reason, account, model)
      logger.warn(`HTTP 400 on ${account.email}: ${message || 'unknown'}`)
      showToast(`400: ${message || 'unknown'}`, 'error')
      return { shouldRetry: false }
    }

    if (response.status === 401 && context.retry < this.config.rate_limit_max_retries) {
      const reason = await readBody()
      logger.warn(
        `HTTP 401 on ${account.email} (retry ${context.retry}): ${reason || 'Unauthorized'}`
      )
      showToast(`401: ${reason || 'Unauthorized'}. Retrying...`, 'warning')
      return {
        shouldRetry: true,
        newContext: { ...context, retry: context.retry + 1 }
      }
    }

    if (response.status === 500) {
      let errorMessage = 'Internal Server Error'
      try {
        const errorBody = await response.text()
        const errorData = JSON.parse(errorBody)
        if (errorData.message) {
          errorMessage = errorData.message
        } else if (errorData.Message) {
          errorMessage = errorData.Message
        }
      } catch (e) {}

      logger.warn(`HTTP 500 on ${account.email} (attempt ${context.retry + 1}): ${errorMessage}`)

      if (context.retry < this.config.rate_limit_max_retries) {
        const delay = 1000 * Math.pow(2, context.retry)
        showToast(`500: ${errorMessage}. Retrying in ${Math.ceil(delay / 1000)}s...`, 'warning')
        await this.sleep(delay)
        return { shouldRetry: true, newContext: { ...context, retry: context.retry + 1 } }
      }

      // 500 is server-side; never mark unhealthy.
      if (this.accountManager.getAccountCount() > 1) {
        showToast(`500: ${errorMessage}. Switching account...`, 'warning')
        return { shouldRetry: true, switchAccount: true }
      }

      showToast(`500: ${errorMessage}. Persistent server error, please retry shortly.`, 'error')
      return { shouldRetry: false }
    }

    if (response.status === 429) {
      const w = parseInt(response.headers.get('retry-after') || '60') * 1000
      logger.warn(`HTTP 429 on ${account.email}: rate limited, retry-after=${Math.ceil(w / 1000)}s`)
      const count = this.accountManager.getAccountCount()

      // Several accounts: park this one and hand the request to a healthy one straight away.
      if (count > 1) {
        await this.accountManager.markRateLimited(account, w)
        return { shouldRetry: true, switchAccount: true }
      }

      // Single account: nothing to switch to. Retry immediately instead of sleeping,
      // bounded by rate_limit_max_retries, then fail loudly.
      if (context.retry < this.config.rate_limit_max_retries) {
        showToast(
          `429: rate limited (server asked for ${Math.ceil(w / 1000)}s). Retrying now...`,
          'warning'
        )
        return { shouldRetry: true, newContext: { ...context, retry: context.retry + 1 } }
      }
      showToast(
        `429: still rate limited after ${this.config.rate_limit_max_retries} retries. ` +
          `The server asked for ${Math.ceil(w / 1000)}s — add a second Kiro account or retry shortly.`,
        'error'
      )
      return { shouldRetry: false }
    }

    if (response.status === 402 || response.status === 403) {
      let errorReason = response.status === 402 ? 'Quota' : 'Forbidden'
      let isPermanent = false
      const errorBody = await response.text()
      const errorData = (() => {
        try {
          return JSON.parse(errorBody)
        } catch {
          return null
        }
      })()
      if (errorData?.message) {
        errorReason = errorData.message
      }
      if (errorData?.reason === 'INVALID_MODEL_ID') {
        throw new Error(`Invalid model: ${errorData.message}`)
      }
      if (errorData?.reason === 'TEMPORARILY_SUSPENDED') {
        errorReason = 'Account Suspended'
        isPermanent = true
      }
      const isBearerInvalid =
        errorReason.includes('bearer token included in the request is invalid') ||
        errorReason.includes('The bearer token included in the request is invalid')

      if (isBearerInvalid && !context.bearerRetried) {
        showToast('403: Bearer token stale after idle. Refreshing and retrying...', 'warning')
        return {
          shouldRetry: true,
          newContext: { ...context, retry: context.retry + 1, bearerRetried: true },
          forceRefresh: true
        }
      }

      if (isBearerInvalid) {
        isPermanent = true
      }
      if (isPermanent) {
        account.failCount = 10
      }

      logger.warn(`HTTP ${response.status} on ${account.email}: ${errorReason}`, {
        isPermanent,
        retry: context.retry,
        reason: errorData?.reason
      })

      if (this.accountManager.getAccountCount() > 1) {
        showToast(`${response.status}: ${errorReason}. Switching account...`, 'warning')
        await this.accountManager.markUnhealthy(account, errorReason)
        return { shouldRetry: true, switchAccount: true }
      }

      if (isPermanent) {
        await this.accountManager.markUnhealthy(account, errorReason)
        return { shouldRetry: false }
      }

      if (
        response.status === 403 &&
        !isPermanent &&
        context.retry < this.config.rate_limit_max_retries
      ) {
        const delay = this.config.rate_limit_retry_delay_ms * Math.pow(2, context.retry)
        showToast(`403: ${errorReason}. Retrying in ${Math.ceil(delay / 1000)}s...`, 'warning')
        await this.sleep(delay)
        return {
          shouldRetry: true,
          newContext: { ...context, retry: context.retry + 1 }
        }
      }

      showToast(`${response.status}: ${errorReason}`, 'error')
      return { shouldRetry: false }
    }

    const reason = await readBody()
    logger.warn(`HTTP ${response.status} on ${account.email}: ${reason || response.statusText}`)
    showToast(`${response.status}: ${reason || response.statusText}`, 'error')
    return { shouldRetry: false }
  }

  async handleNetworkError(
    error: any,
    context: RequestContext,
    showToast: ToastFunction
  ): Promise<{ shouldRetry: boolean; newContext?: RequestContext }> {
    if (this.isNetworkError(error) && context.retry < this.config.rate_limit_max_retries) {
      const d = this.config.rate_limit_retry_delay_ms * Math.pow(2, context.retry)
      showToast(`Network error. Retrying in ${Math.ceil(d / 1000)}s...`, 'warning')
      await this.sleep(d)
      return {
        shouldRetry: true,
        newContext: { ...context, retry: context.retry + 1 }
      }
    }
    return { shouldRetry: false }
  }

  // Kiro rolls out model availability per region gradually; reword its bare
  // "Invalid model ID" into something actionable without guessing at regions.
  private enrichIfInvalidModel(reason: string, account: ManagedAccount, model?: string): string {
    if (!reason || !/invalid model id/i.test(reason)) {
      return reason
    }
    const region = account.region || 'your account\u2019s region'
    const modelPart = model ? `Model "${model}"` : 'This model'
    return (
      `${modelPart} is not available via region "${region}". Kiro rolls out model ` +
      `availability gradually per region — check https://kiro.dev/docs/models/ for current ` +
      `availability. (${reason})`
    )
  }

  private isNetworkError(e: any): boolean {
    return (
      e instanceof Error && /econnreset|etimedout|enotfound|network|fetch failed/i.test(e.message)
    )
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }
}
