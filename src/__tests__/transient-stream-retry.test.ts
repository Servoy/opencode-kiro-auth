import { CodeWhispererStreamingClient } from '@aws/codewhisperer-streaming-client'
import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { clearSdkClientCache } from '../plugin/sdk-client.js'

// A transient failure (MODEL_TEMPORARILY_UNAVAILABLE) arrives *inside* the event
// stream after client.send() has already succeeded — outside the SDK's own
// retry. These tests drive the whole RequestHandler loop to prove the stream
// failure is routed back through the same backoff/switch machinery an HTTP 503
// would take, and that the retry stops at the configured ceiling.

// How many events the mocked stream yields before throwing, and what it throws.
let streamReason = 'The service is temporarily unavailable. (MODEL_TEMPORARILY_UNAVAILABLE)'
let eventsBeforeThrow = 0
let sendCalls = 0

mock.module('../plugin/logger.js', () => ({
  debug: () => {},
  error: () => {},
  setDebugEnabled: () => {},
  getTimestamp: () => '2026-07-22T00:00:00.000Z',
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

// client.send resolves (HTTP 200); the failure is in the stream it returns.
const sendSpy = spyOn(CodeWhispererStreamingClient.prototype, 'send').mockImplementation(
  async () => {
    sendCalls++
    return {
      $metadata: { httpStatusCode: 200 },
      generateAssistantResponseResponse: (async function* () {
        for (let i = 0; i < eventsBeforeThrow; i++) {
          yield { assistantResponseEvent: { content: 'a real chunk of visible assistant text' } }
        }
        throw new Error(streamReason)
      })()
    } as any
  }
)

const { RequestHandler } = await import('../core/request/request-handler.js')

afterAll(() => {
  clearSdkClientCache()
  sendSpy.mockRestore()
})

const originalFetch = globalThis.fetch
globalThis.fetch = (async () => {
  throw new Error('no network in tests')
}) as unknown as typeof fetch

afterAll(() => {
  globalThis.fetch = originalFetch
})

function createHarness(accountCount: number) {
  clearSdkClientCache()
  sendCalls = 0

  const accounts: any[] = []
  for (let i = 0; i < accountCount; i++) {
    accounts.push({
      id: `account-${i}`,
      email: `user${i}@example.com`,
      authMethod: 'idc',
      region: 'us-east-1',
      profileArn: `arn:aws:codewhisperer:us-east-1:123456789012:profile/ABC${i}`,
      refreshToken: 'refresh-token',
      accessToken: 'access-token',
      expiresAt: Date.now() + 60_000,
      isHealthy: true,
      failCount: 0,
      usedCount: 0,
      limitCount: 0
    })
  }

  let selectIndex = 0
  const accountManager: any = {
    getAccounts: () => accounts,
    getAccountCount: () => accounts.length,
    markUnhealthy: (acc: any, reason: string) => {
      acc.isHealthy = false
      acc.unhealthyReason = reason
    },
    markRateLimited: async () => {},
    toAuthDetails: (selected: any) => ({
      access: selected.accessToken,
      refresh: selected.refreshToken,
      expires: selected.expiresAt,
      authMethod: selected.authMethod,
      region: selected.region,
      email: selected.email,
      profileArn: selected.profileArn
    })
  }

  const repository: any = {
    batchSave: async () => {},
    save: async () => {},
    invalidateCache: () => {},
    findAll: async () => accounts
  }

  const config: any = {
    max_request_iterations: 10,
    request_timeout_ms: 5_000,
    rate_limit_max_retries: 2,
    rate_limit_retry_delay_ms: 1,
    token_expiry_buffer_ms: 0,
    auto_sync_kiro_cli: false,
    account_selection_strategy: 'sticky',
    enable_log_api_request: false
  }

  const handler: any = new RequestHandler(accountManager, config, repository)
  handler.accountSelector = {
    // Round-robin so an account switch actually lands on a different account.
    selectHealthyAccount: async () => accounts[selectIndex++ % accounts.length]
  }
  handler.tokenRefresher = {
    refreshIfNeeded: async (selected: any) => ({ account: selected, shouldContinue: false }),
    forceRefresh: async () => true,
    refreshPreservingAccountHealth: async () => true
  }
  handler.triggerReauth = async () => false
  handler.prepareSdkRequest = () => ({
    region: 'us-east-1',
    effort: undefined,
    conversationState: {},
    profileArn: undefined,
    conversationId: 'conversation-1',
    conversationKey: { workspace: 'test-workspace', fingerprint: 'test-fingerprint' },
    streaming: true,
    effectiveModel: 'claude-sonnet-4-5'
  })

  return { handler, accounts }
}

function request(handler: any) {
  return handler.handle(
    'https://q.us-east-1.amazonaws.com/models/claude-sonnet-4-5',
    { body: '{}' },
    () => {}
  )
}

describe('RequestHandler transient in-stream failure', () => {
  test('single account: retries up to the ceiling, then returns a host-visible 503', async () => {
    streamReason = 'The service is temporarily unavailable. (MODEL_TEMPORARILY_UNAVAILABLE)'
    eventsBeforeThrow = 0
    const { handler, accounts } = createHarness(1)

    const response = await request(handler)

    // rate_limit_max_retries=2 → attempts at retry 0,1,2 then terminal = 3 sends.
    expect(sendCalls).toBe(3)
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain('Kiro:')
    // Server-side: the account is never condemned.
    expect(accounts[0].isHealthy).toBe(true)
  })

  test('multi account: NEVER switches — it backs off on the same account and fails there', async () => {
    // Even with a second account standing by, a transient model blip must stay
    // on the pinned account: switching abandons the conversationId and the warm
    // prompt cache, re-billing the rest of the session. So it backs off up to
    // the ceiling (3 sends, never more) and fails, both accounts untouched.
    streamReason = 'MODEL_TEMPORARILY_UNAVAILABLE'
    eventsBeforeThrow = 0
    const { handler, accounts } = createHarness(2)

    const response = await request(handler)

    expect(response.status).toBe(503)
    // Capped at one account's budget — no handoff to the second account.
    expect(sendCalls).toBe(3)
    expect(accounts[0].isHealthy).toBe(true)
    expect(accounts[1].isHealthy).toBe(true)
  })

  test('a non-transient in-stream failure is not retried — it propagates, not looped as 503', async () => {
    // A stream that throws something that is not a transient reason must fall
    // through to the normal path (which rethrows here), not loop on the 503
    // branch: one send, and the error surfaces rather than a retry.
    streamReason = 'Invalid model ID'
    eventsBeforeThrow = 0
    const { handler } = createHarness(1)

    let threw = false
    try {
      await request(handler)
    } catch {
      threw = true
    }

    expect(threw).toBe(true)
    expect(sendCalls).toBe(1)
  })

  test('once a chunk is out, a transient failure is NOT retried — the body is committed', async () => {
    // The first event streams cleanly, committing the body. The transient
    // failure that follows can only end the stream; the request must not be
    // replayed (Smithy: a started stream cannot be retried).
    streamReason = 'MODEL_TEMPORARILY_UNAVAILABLE'
    eventsBeforeThrow = 2
    const { handler } = createHarness(1)

    const response = await request(handler)

    // Exactly one send: no retry after output began.
    expect(sendCalls).toBe(1)
    expect(response.status).toBe(200)

    // Draining the committed stream surfaces the error to the consumer.
    const reader = response.body!.getReader()
    let threw = false
    let text = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) text += new TextDecoder().decode(value)
      }
    } catch {
      threw = true
    }
    expect(text).toContain('data:')
    expect(threw).toBe(true)
  })
})
