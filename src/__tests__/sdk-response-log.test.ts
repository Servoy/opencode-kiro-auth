import { CodeWhispererStreamingClient } from '@aws/codewhisperer-streaming-client'
import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { clearSdkClientCache } from '../plugin/sdk-client.js'

// Capture exactly what the API-response log receives on the SUCCESS path, so a
// regression that reintroduces the invented `status: 200, statusText: 'OK'`
// (which masked empty/truncated streams) fails here.
let loggedResponses: any[] = []

mock.module('../plugin/logger.js', () => ({
  debug: () => {},
  error: () => {},
  setDebugEnabled: () => {},
  getTimestamp: () => '2026-10-02T00:00:00.000Z',
  log: () => {},
  logApiError: () => {},
  logApiRequest: () => {},
  logApiResponse: (data: any) => {
    loggedResponses.push(data)
  },
  warn: () => {}
}))

const realModels = await import('../plugin/models.js')
mock.module('../plugin/models.js', () => ({
  ...realModels,
  refreshModelCatalog: async () => {}
}))

// A successful SDK call: the response carries retry metadata and an empty event
// stream, mirroring the shape handleSdkSuccess consumes.
const sendSpy = spyOn(CodeWhispererStreamingClient.prototype, 'send').mockImplementation(
  async () =>
    ({
      $metadata: { attempts: 3, totalRetryDelay: 1200 },
      generateAssistantResponseResponse: (async function* () {})()
    }) as any
)

const { RequestHandler } = await import('../core/request/request-handler.js')

const originalFetch = globalThis.fetch
globalThis.fetch = (async () => {
  throw new Error('no network in tests')
}) as unknown as typeof fetch

afterAll(() => {
  clearSdkClientCache()
  sendSpy.mockRestore()
  globalThis.fetch = originalFetch
})

function createHarness() {
  clearSdkClientCache()
  loggedResponses = []

  const account: any = {
    id: 'account-1',
    email: 'user@example.com',
    authMethod: 'idc',
    region: 'us-east-1',
    profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/ABC',
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
    toAuthDetails: (selected: any) => ({
      access: selected.accessToken,
      refresh: selected.refreshToken,
      expires: selected.expiresAt,
      authMethod: selected.authMethod,
      region: selected.region,
      email: selected.email
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
    rate_limit_max_retries: 2,
    rate_limit_retry_delay_ms: 1,
    token_expiry_buffer_ms: 0,
    auto_sync_kiro_cli: false,
    account_selection_strategy: 'sticky',
    enable_log_api_request: true
  }

  const handler: any = new RequestHandler(accountManager, config, repository)

  handler.accountSelector = { selectHealthyAccount: async () => account }
  handler.tokenRefresher = {
    refreshIfNeeded: async (selected: any) => ({ account: selected, shouldContinue: false })
  }
  handler.prepareSdkRequest = () => ({
    region: 'us-east-1',
    effort: undefined,
    conversationState: {},
    profileArn: undefined,
    conversationId: 'conversation-1',
    conversationKey: { workspace: 'test-workspace', fingerprint: 'test-fingerprint' },
    streaming: false,
    effectiveModel: 'claude-sonnet-4-5'
  })

  return { handler }
}

function request(handler: any) {
  return handler.handle(
    'https://q.us-east-1.amazonaws.com/models/claude-sonnet-4-5',
    { body: '{}' },
    () => {}
  )
}

describe('SDK response logging on the success path', () => {
  test('logs what is actually known, not an invented HTTP 200', async () => {
    const { handler } = createHarness()
    await request(handler)

    expect(loggedResponses).toHaveLength(1)
    const logged = loggedResponses[0]

    // The request was accepted; the stream is not read yet, so no status is known.
    expect(logged.phase).toBe('request-accepted')
    expect(logged.conversationId).toBe('conversation-1')
    expect(logged.model).toBe('claude-sonnet-4-5')
    // Real SDK retry metadata is carried through, not discarded.
    expect(logged.sdkAttempts).toBe(3)
    expect(logged.sdkTotalRetryDelayMs).toBe(1200)

    // The invented success fields must be gone — they lied about the stream.
    expect(logged.status).toBeUndefined()
    expect(logged.statusText).toBeUndefined()
  })
})
