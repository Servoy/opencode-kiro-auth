import { CodeWhispererStreamingClient } from '@aws/codewhisperer-streaming-client'
import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { clearSdkClientCache } from '../plugin/sdk-client.js'

// Drives the real RequestHandler loop with a mocked Kiro stream that carries a
// meteringEvent, and asserts the metered credits land in the real kiroDb on the
// session and account that served the request. This is the wiring the panel's
// credit numbers depend on; the unit tests alone would not catch it unplugged.

mock.module('../plugin/logger.js', () => ({
  debug: () => {},
  error: () => {},
  setDebugEnabled: () => {},
  getTimestamp: () => '2026-11-18T00:00:00.000Z',
  log: () => {},
  logApiError: () => {},
  logApiRequest: () => {},
  logApiResponse: () => {},
  warn: () => {}
}))

const realModels = await import('../plugin/models.js')
mock.module('../plugin/models.js', () => ({
  ...realModels,
  refreshModelCatalog: async () => {}
}))

let metered = 0
const sendSpy = spyOn(CodeWhispererStreamingClient.prototype, 'send').mockImplementation(
  async () =>
    ({
      $metadata: { httpStatusCode: 200 },
      generateAssistantResponseResponse: (async function* () {
        yield { assistantResponseEvent: { content: 'answer' } }
        yield { meteringEvent: { usage: metered, unit: 'credit' } }
      })()
    }) as any
)

const { RequestHandler } = await import('../core/request/request-handler.js')
const { kiroDb } = await import('../plugin/storage/sqlite.js')

const originalFetch = globalThis.fetch
globalThis.fetch = (async () => {
  throw new Error('no network in tests')
}) as unknown as typeof fetch

afterAll(() => {
  clearSdkClientCache()
  sendSpy.mockRestore()
  globalThis.fetch = originalFetch
})

function harness() {
  clearSdkClientCache()
  const account: any = {
    id: 'acc-wire',
    email: 'wire@example.com',
    authMethod: 'idc',
    region: 'us-east-1',
    profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/WIRE',
    refreshToken: 'refresh-token',
    accessToken: 'access-token',
    expiresAt: Date.now() + 60_000,
    isHealthy: true,
    failCount: 0,
    usedCount: 0,
    limitCount: 0
  }
  const accountManager: any = {
    getAccounts: () => [account],
    getAccountCount: () => 1,
    markUnhealthy: () => {},
    markRateLimited: async () => {},
    toAuthDetails: (a: any) => ({
      access: a.accessToken,
      refresh: a.refreshToken,
      expires: a.expiresAt,
      authMethod: a.authMethod,
      region: a.region,
      email: a.email,
      profileArn: a.profileArn
    })
  }
  const repository: any = {
    batchSave: async () => {},
    save: async () => {},
    invalidateCache: () => {},
    findAll: async () => [account]
  }
  const config: any = {
    max_request_iterations: 5,
    request_timeout_ms: 5_000,
    rate_limit_max_retries: 1,
    rate_limit_retry_delay_ms: 1,
    token_expiry_buffer_ms: 0,
    auto_sync_kiro_cli: false,
    account_selection_strategy: 'sticky',
    enable_log_api_request: false,
    usage_tracking_enabled: false
  }
  const handler: any = new RequestHandler(accountManager, config, repository)
  handler.accountSelector = { selectHealthyAccount: async () => account }
  handler.tokenRefresher = {
    refreshIfNeeded: async (a: any) => ({ account: a, shouldContinue: false }),
    forceRefresh: async () => true,
    refreshPreservingAccountHealth: async () => true
  }
  handler.triggerReauth = async () => false
  handler.prepareSdkRequest = () => ({
    region: 'us-east-1',
    effort: undefined,
    conversationState: {},
    profileArn: undefined,
    conversationId: 'conv-wire',
    conversationKey: { workspace: 'ws', fingerprint: 'fp' },
    streaming: true,
    effectiveModel: 'claude-sonnet-4-5'
  })
  return handler
}

describe('metered credits wiring', () => {
  test('a served response books its metered credits on its session and serving account', async () => {
    const handler = harness()
    metered = 1.5
    const r1 = await handler.handle(
      'https://q.us-east-1.amazonaws.com/models/claude-sonnet-4-5',
      { body: '{}', headers: { 'x-session-id': 'ses-wire' } },
      () => {}
    )
    await r1.text()
    metered = 0.25
    const r2 = await handler.handle(
      'https://q.us-east-1.amazonaws.com/models/claude-sonnet-4-5',
      { body: '{}', headers: { 'x-session-id': 'ses-wire' } },
      () => {}
    )
    await r2.text()

    const usage = kiroDb.getSessionUsage('ses-wire')
    expect(usage?.requests).toBe(2)
    expect(usage?.estCredits).toBeCloseTo(1.75, 10)
    expect(usage?.accounts.map((a) => a.accountId)).toEqual(['acc-wire'])
  })
})
