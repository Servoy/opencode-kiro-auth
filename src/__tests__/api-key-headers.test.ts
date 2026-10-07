import { GenerateAssistantResponseCommand } from '@aws/codewhisperer-streaming-client'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { KiroAuthDetails } from '../plugin/types.js'

const realLogger = await import('../plugin/logger.js')
mock.module('../plugin/logger.js', () => ({
  ...realLogger,
  debug: () => {},
  error: () => {},
  log: () => {},
  warn: () => {}
}))

const { kiroHeaders } = await import('../plugin/http-headers.js')
const { refreshModelCatalog, resetModelCatalog } = await import('../plugin/models.js')
const { fetchUsageLimits } = await import('../plugin/usage.js')
const { kiroWebSearch } = await import('../plugin/web-search.js')
const { clearSdkClientCache, createSdkClient } = await import('../plugin/sdk-client.js')

const ARN = 'arn:aws:codewhisperer:us-east-1:123456789012:profile/ABC'
const originalFetch = globalThis.fetch

function authFor(authMethod: 'apikey' | 'idc'): KiroAuthDetails {
  return {
    refresh: authMethod === 'apikey' ? 'apikey:0123456789abcdef|apikey' : 'r|c|s|idc',
    access: 'ksk_TESTKEY000000000000000000000000',
    expires: authMethod === 'apikey' ? 0 : Date.now() + 3_600_000,
    authMethod,
    region: 'us-east-1',
    profileArn: ARN,
    email: `${authMethod}@example.com`
  }
}

function captureFetchHeaders(status = 500): { headers: Record<string, string>[] } {
  const seen: { headers: Record<string, string>[] } = { headers: [] }
  globalThis.fetch = (async (_url: any, init?: any) => {
    seen.headers.push({ ...(init?.headers ?? {}) })
    return new Response('{}', { status })
  }) as unknown as typeof fetch
  return seen
}

async function chatHeaders(auth: KiroAuthDetails): Promise<Record<string, string>> {
  clearSdkClientCache()
  const client = createSdkClient(auth, 'us-east-1')
  let captured: any
  client.middlewareStack.add(
    () => async (args: any) => {
      captured = args.request
      throw new Error('captured-request')
    },
    { step: 'finalizeRequest', name: 'captureRequest', priority: 'high' }
  )
  await client
    .send(
      new GenerateAssistantResponseCommand({
        conversationState: {
          chatTriggerType: 'MANUAL',
          conversationId: 'test-conversation',
          currentMessage: {
            userInputMessage: { content: 'hello', modelId: 'claude-sonnet-5', origin: 'AI_EDITOR' }
          }
        }
      })
    )
    .catch((e: Error) => {
      if (e.message !== 'captured-request') throw e
    })
  return captured.headers
}

async function runWebSearch(method: 'apikey' | 'idc'): Promise<void> {
  const auth = authFor(method)
  const account: any = { id: method, authMethod: method, profileArn: ARN }
  const accountManager: any = {
    getCurrentOrNext: () => account,
    toAuthDetails: () => auth,
    updateFromAuth: async () => {}
  }
  await kiroWebSearch(accountManager, 'servoy').catch(() => {})
}

beforeEach(() => {
  resetModelCatalog()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  resetModelCatalog()
  clearSdkClientCache()
})

describe('the tokentype header', () => {
  test('kiroHeaders adds tokentype only for apikey', () => {
    expect(kiroHeaders(ARN, 'apikey').tokentype).toBe('API_KEY')
    expect('tokentype' in kiroHeaders(ARN, 'idc')).toBe(false)
    expect('tokentype' in kiroHeaders(ARN, 'desktop')).toBe(false)
    expect('tokentype' in kiroHeaders(ARN)).toBe(false)
    expect('tokentype' in kiroHeaders()).toBe(false)
  })

  test('the catalog request carries it for an apikey account and not for idc', async () => {
    const key = captureFetchHeaders()
    await refreshModelCatalog(authFor('apikey')).catch(() => {})
    resetModelCatalog()
    const idc = captureFetchHeaders()
    await refreshModelCatalog(authFor('idc')).catch(() => {})

    expect(key.headers).toHaveLength(1)
    expect(key.headers[0]!.tokentype).toBe('API_KEY')
    expect(idc.headers).toHaveLength(1)
    expect('tokentype' in idc.headers[0]!).toBe(false)
  })

  test('the usage request carries it for an apikey account and not for idc', async () => {
    const key = captureFetchHeaders()
    await fetchUsageLimits(authFor('apikey')).catch(() => {})
    const idc = captureFetchHeaders()
    await fetchUsageLimits(authFor('idc')).catch(() => {})

    expect(key.headers[0]!.tokentype).toBe('API_KEY')
    expect('tokentype' in idc.headers[0]!).toBe(false)
  })

  test('the chat request carries it for an apikey account and not for idc', async () => {
    expect((await chatHeaders(authFor('apikey'))).tokentype).toBe('API_KEY')
    expect('tokentype' in (await chatHeaders(authFor('idc')))).toBe(false)
  })

  test('the web search request carries it for an apikey account and not for idc', async () => {
    const key = captureFetchHeaders()
    await runWebSearch('apikey')
    const idc = captureFetchHeaders()
    await runWebSearch('idc')

    expect(key.headers[0]!.tokentype).toBe('API_KEY')
    expect('tokentype' in idc.headers[0]!).toBe(false)
  })

  test('the web search request names the client for an apikey account only', async () => {
    const key = captureFetchHeaders()
    await runWebSearch('apikey')
    const idc = captureFetchHeaders()
    await runWebSearch('idc')

    expect(key.headers[0]!['user-agent']).toMatch(/^KiroIDE-[\d.]+-[0-9a-f]{64}$/)
    expect('user-agent' in idc.headers[0]!).toBe(false)
  })
})
