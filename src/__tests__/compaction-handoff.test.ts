import { CodeWhispererStreamingClient } from '@aws/codewhisperer-streaming-client'
import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { clearSdkClientCache } from '../plugin/sdk-client.js'

// Drives the real RequestHandler with the real request builder and kiroDb, so
// the over-cap decision, the stored flag and the response the host sees are
// the ones production runs. Only the Kiro stream is mocked.

mock.module('../plugin/logger.js', () => ({
  debug: () => {},
  error: () => {},
  setDebugEnabled: () => {},
  getTimestamp: () => '2026-11-19T00:00:00.000Z',
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

const sentHistoryLengths: number[] = []
const sendSpy = spyOn(CodeWhispererStreamingClient.prototype, 'send').mockImplementation(
  async (command: any) => {
    sentHistoryLengths.push(command?.input?.conversationState?.history?.length ?? 0)
    return {
      $metadata: { httpStatusCode: 200 },
      generateAssistantResponseResponse: (async function* () {
        yield { assistantResponseEvent: { content: 'answer' } }
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

const CAP = 200_000

function harness() {
  clearSdkClientCache()
  const account: any = {
    id: 'acc-compact',
    email: 'compact@example.com',
    authMethod: 'idc',
    region: 'us-east-1',
    profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/COMPACT',
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
    usage_tracking_enabled: false,
    image_carry_forward: true,
    max_payload_bytes: CAP
  }
  const handler: any = new RequestHandler(accountManager, config, repository)
  handler.accountSelector = { selectHealthyAccount: async () => account }
  handler.tokenRefresher = {
    refreshIfNeeded: async (a: any) => ({ account: a, shouldContinue: false }),
    forceRefresh: async () => true,
    refreshPreservingAccountHealth: async () => true
  }
  handler.triggerReauth = async () => false
  return handler
}

/** A conversation of `turns` exchanges of `chars` characters each, ending on a question. */
function conversation(turns: number, chars: number): any[] {
  const messages: any[] = []
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'user', content: `q${i} ` + 'x'.repeat(chars) })
    messages.push({ role: 'assistant', content: `a${i} ` + 'y'.repeat(chars) })
  }
  messages.push({ role: 'user', content: 'and now?' })
  return messages
}

async function turn(handler: any, sessionId: string, messages: any[]): Promise<Response> {
  const response: Response = await handler.handle(
    'https://q.us-east-1.amazonaws.com/models/claude-sonnet-4-5',
    {
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages }),
      headers: { 'x-session-id': sessionId }
    },
    () => {}
  )
  return response
}

describe('an over-cap conversation is handed to the host to compact', () => {
  test('the host is asked once, in the shape OpenCode compacts on', async () => {
    const handler = harness()
    sentHistoryLengths.length = 0
    const big = conversation(40, 4_000)

    const refused = await turn(handler, 'ses-compact-1', big)
    expect(refused.status).toBe(400)
    // OpenCode's classifier treats this code as `context-overflow`, the only
    // classification its runner recovers from by compacting.
    const body = (await refused.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('context_length_exceeded')
    expect(body.error.message).toMatch(/prompt is too long/i)
    expect(sentHistoryLengths).toEqual([])

    // A host that did not compact, or a compaction still over the cap, is not
    // refused again: OpenCode recovers once per prompt, so a second refusal
    // would fail the turn. The plugin cuts the history instead.
    const served = await turn(handler, 'ses-compact-1', big)
    expect(served.status).toBe(200)
    await served.text()
    expect(sentHistoryLengths).toHaveLength(1)
    expect(sentHistoryLengths[0]!).toBeLessThan(80)
  })

  test('once a request fits again, the next overflow asks again', async () => {
    const handler = harness()
    sentHistoryLengths.length = 0

    expect((await turn(handler, 'ses-compact-2', conversation(40, 4_000))).status).toBe(400)

    // The compacted conversation fits and is sent whole.
    const compacted = await turn(handler, 'ses-compact-2', conversation(2, 1_000))
    expect(compacted.status).toBe(200)
    await compacted.text()
    expect(sentHistoryLengths).toEqual([4])

    // It grows past the cap again: compacting is the host's job once more.
    expect((await turn(handler, 'ses-compact-2', conversation(40, 4_000))).status).toBe(400)
    expect(sentHistoryLengths).toEqual([4])
  })

  test('a conversation that fits is never refused', async () => {
    const handler = harness()
    sentHistoryLengths.length = 0
    const response = await turn(handler, 'ses-compact-3', conversation(3, 1_000))
    expect(response.status).toBe(200)
    await response.text()
    expect(sentHistoryLengths).toEqual([6])
  })
})
