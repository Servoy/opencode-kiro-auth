import { describe, expect, mock, test } from 'bun:test'
import { isPermanentError, isTransientNetworkError } from '../plugin/health.js'

const toasts: string[] = []

mock.module('../plugin/logger.js', () => ({
  debug: () => {},
  error: () => {},
  log: () => {},
  warn: () => {},
  getTimestamp: () => '2026-07-22T00:00:00.000Z'
}))

const { TokenRefresher } = await import('../core/auth/token-refresher.js')

function createRefresher() {
  const account: any = {
    id: 'acc-1',
    email: 'user@servoy.com',
    authMethod: 'idc',
    region: 'eu-central-1',
    refreshToken: 'r',
    accessToken: 'a',
    expiresAt: Date.now() - 1_000,
    isHealthy: true,
    failCount: 0
  }

  const marked: string[] = []
  const accountManager: any = {
    updateFromAuth: async () => {},
    markUnhealthy: async (_acc: any, reason: string) => marked.push(reason),
    toAuthDetails: (a: any) => ({
      access: a.accessToken,
      refresh: a.refreshToken,
      expires: a.expiresAt,
      authMethod: a.authMethod,
      region: a.region,
      email: a.email
    })
  }

  const repository: any = {
    save: async () => {},
    invalidateCache: () => {},
    // Empty, so the "recovered from Kiro CLI sync" branch cannot fire and the
    // assertion is about connectivity handling alone.
    findAll: async () => []
  }

  const config: any = {
    token_expiry_buffer_ms: 0,
    auto_sync_kiro_cli: false,
    account_selection_strategy: 'sticky'
  }

  const refresher = new TokenRefresher(config, accountManager, async () => {}, repository)
  return { refresher, account, marked }
}

describe('losing connectivity mid-session', () => {
  test('a transport failure stays retryable instead of killing the request', async () => {
    toasts.length = 0
    const { refresher, account, marked } = createRefresher()

    const result = await (refresher as any).handleRefreshError(
      new Error('Unable to connect. Is the computer able to access the url?'),
      account,
      (m: string) => toasts.push(m)
    )

    expect(result.shouldContinue).toBe(true)
    expect(marked).toEqual([])
    expect(toasts.some((t) => /no connection/i.test(t))).toBe(true)
  })

  test('the message names the connection, not the URL', () => {
    expect(toasts.every((t) => !/typo|url/i.test(t))).toBe(true)
  })
})

describe('classifying failures', () => {
  test('transport text from a sleeping laptop is transient', () => {
    for (const reason of [
      'Unable to connect. Is the computer able to access the url?',
      'Was there a typo in the url or port?',
      'fetch failed',
      'connect ETIMEDOUT 10.0.0.1:443',
      'getaddrinfo EAI_AGAIN oidc.eu-central-1.amazonaws.com'
    ]) {
      expect(isTransientNetworkError(reason)).toBe(true)
      expect(isPermanentError(reason)).toBe(false)
    }
  })

  test('a rejected credential is not a network problem', () => {
    for (const reason of ['Invalid refresh token provided', 'ExpiredTokenException', 'HTTP_401']) {
      expect(isTransientNetworkError(reason)).toBe(false)
      expect(isPermanentError(reason)).toBe(true)
    }
  })
})
