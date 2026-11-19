import { CodeWhispererStreamingClient } from '@aws/codewhisperer-streaming-client'
import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { clearSdkClientCache } from '../plugin/sdk-client.js'

// Kiro reports it cannot serve the model the turn asked for. These tests drive
// the whole RequestHandler loop to prove the turn moves to the next model in
// the chain, that it only does so for a capacity failure, and that the answer
// is labelled with the model that actually served it.

/** Models that answer with a capacity failure instead of content. */
let refusing = new Set<string>()
/** What a refusing model throws inside its event stream. */
let refusalReason = 'The service is temporarily unavailable. (MODEL_TEMPORARILY_UNAVAILABLE)'
let preparedModels: string[] = []

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

const sendSpy = spyOn(CodeWhispererStreamingClient.prototype, 'send').mockImplementation(
  async () => {
    const model = preparedModels[preparedModels.length - 1]!
    return {
      $metadata: { httpStatusCode: 200 },
      generateAssistantResponseResponse: (async function* () {
        if (refusing.has(model)) throw new Error(refusalReason)
        yield { assistantResponseEvent: { content: 'a real chunk of visible assistant text' } }
        yield { assistantResponseEvent: { content: ' and a little more of it' } }
      })()
    } as any
  }
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

function createHarness(fallbacks: Record<string, string[]>) {
  clearSdkClientCache()
  preparedModels = []

  const account: any = {
    id: 'account-0',
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
    findAll: async () => [account]
  }

  const config: any = {
    max_request_iterations: 30,
    request_timeout_ms: 5_000,
    rate_limit_max_retries: 1,
    rate_limit_retry_delay_ms: 1,
    token_expiry_buffer_ms: 0,
    auto_sync_kiro_cli: false,
    account_selection_strategy: 'sticky',
    enable_log_api_request: false,
    model_fallbacks: fallbacks
  }

  const handler: any = new RequestHandler(accountManager, config, repository)
  handler.accountSelector = { selectHealthyAccount: async () => account }
  handler.tokenRefresher = {
    refreshIfNeeded: async (selected: any) => ({ account: selected, shouldContinue: false }),
    forceRefresh: async () => true,
    refreshPreservingAccountHealth: async () => true
  }
  handler.triggerReauth = async () => false
  // The real one needs a conversation store; what matters here is that the
  // model the loop decided on is the model the request is built for.
  handler.prepareSdkRequest = (_body: unknown, model: string) => {
    preparedModels.push(model)
    return {
      region: 'us-east-1',
      effort: undefined,
      conversationState: {},
      profileArn: undefined,
      conversationId: 'conversation-1',
      conversationKey: { workspace: 'test-workspace', fingerprint: 'test-fingerprint' },
      streaming: true,
      effectiveModel: model
    }
  }

  const toasts: string[] = []
  const request = () =>
    handler.handle(
      'https://q.us-east-1.amazonaws.com/models/claude-sonnet-5-5',
      { body: '{}' },
      (message: string) => toasts.push(message)
    )

  return { request, toasts, account }
}

const CHAIN = { 'claude-sonnet-5-5': ['claude-sonnet-5'], 'claude-sonnet-5': ['claude-sonnet-4-6'] }

async function readSse(response: Response): Promise<string> {
  return await response.text()
}

describe('a model that cannot be served', () => {
  test('hands the turn to the next model in the chain and answers there', async () => {
    refusalReason = 'The service is temporarily unavailable. (MODEL_TEMPORARILY_UNAVAILABLE)'
    refusing = new Set(['claude-sonnet-5-5'])
    const { request, toasts } = createHarness(CHAIN)

    const response = await request()

    expect(response.status).toBe(200)
    expect(preparedModels[preparedModels.length - 1]).toBe('claude-sonnet-5')
    // The answer is labelled with the model that served it, not the one asked for.
    expect(await readSse(response)).toContain('claude-sonnet-5')
    expect(toasts.some((t) => t.includes('continuing on claude-sonnet-5'))).toBe(true)
  })

  test('walks the whole chain before giving up', async () => {
    refusing = new Set(['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6'])
    const { request } = createHarness(CHAIN)

    const response = await request()

    expect(response.status).toBe(503)
    expect(new Set(preparedModels)).toEqual(
      new Set(['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6'])
    )
  })

  test('keeps the account healthy — the model was at fault, not the credential', async () => {
    refusing = new Set(['claude-sonnet-5-5'])
    const { request, account } = createHarness(CHAIN)

    await request()

    expect(account.isHealthy).toBe(true)
  })
})

describe('failures that are not about the model', () => {
  test('throttling never moves the turn to another model', async () => {
    // A throttle is this account's problem; spending a second model's capacity
    // on it buys nothing and hides the real cause.
    refusalReason = 'ThrottlingException: Too many requests'
    refusing = new Set(['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6'])
    const { request } = createHarness(CHAIN)

    const response = await request()

    expect(response.status).toBe(503)
    expect(new Set(preparedModels)).toEqual(new Set(['claude-sonnet-5-5']))
  })
})

describe('turning the policy off', () => {
  test('an empty chain map fails on the model that was asked for', async () => {
    refusalReason = 'MODEL_TEMPORARILY_UNAVAILABLE'
    refusing = new Set(['claude-sonnet-5-5'])
    const { request } = createHarness({})

    const response = await request()

    expect(response.status).toBe(503)
    expect(new Set(preparedModels)).toEqual(new Set(['claude-sonnet-5-5']))
  })
})
