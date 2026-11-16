import { afterEach, describe, expect, mock, test } from 'bun:test'

const warnings: string[] = []
const debugs: string[] = []

mock.module('../plugin/logger.js', () => ({
  debug: (message: string) => {
    debugs.push(message)
  },
  error: () => {},
  log: () => {},
  warn: (message: string) => {
    warnings.push(message)
  },
  setDebugEnabled: () => {},
  getTimestamp: () => '2026-07-22T00:00:00.000Z',
  logApiError: () => {},
  logApiRequest: () => {},
  logApiResponse: () => {}
}))

const { RequestHandler } = await import('../core/request/request-handler.js')

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  warnings.length = 0
  debugs.length = 0
})

function createHandler() {
  const accountManager: any = { getAccountCount: () => 1 }
  const config: any = {
    request_timeout_ms: 30_000,
    rate_limit_max_retries: 3,
    rate_limit_retry_delay_ms: 1
  }
  const repository: any = {
    save: async () => {},
    batchSave: async () => {},
    findAll: async () => []
  }
  return new RequestHandler(accountManager, config, repository) as any
}

/**
 * A request whose URL was rewritten by another plugin still belongs to Kiro.
 * The plugin used to read the URL as "ours or not" from the front of it, so a
 * rewritten URL made it step aside and the host sent an OpenAI-shaped request
 * to a Kiro endpoint, which answered with an error the user could not act on.
 */
describe('a request whose URL was rewritten', () => {
  test('is still handled as a Kiro request, with the upstream it carries', async () => {
    const handler = createHandler()
    let handledUrl: string | undefined
    handler.handleKiroRequest = async (url: string) => {
      handledUrl = url
      return new Response('handled', { status: 200 })
    }

    const res = await handler.handle(
      'http://127.0.0.1:18789/bili/https://q.us-east-1.amazonaws.com/chat/completions',
      { body: JSON.stringify({ model: 'glm-5', messages: [] }) },
      () => {}
    )

    expect(res.status).toBe(200)
    expect(handledUrl).toBe('https://q.us-east-1.amazonaws.com/chat/completions')
    expect(warnings.some((w) => w.includes('passthrough'))).toBe(false)
  })

  test('is not sent to the network by the fallback path', async () => {
    const handler = createHandler()
    handler.handleKiroRequest = async () => new Response('handled', { status: 200 })

    let fetched = 0
    globalThis.fetch = (async () => {
      fetched++
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    await handler.handle(
      'http://127.0.0.1:18789/bili/https://q.us-east-1.amazonaws.com/chat/completions',
      { body: JSON.stringify({ model: 'glm-5', messages: [] }) },
      () => {}
    )

    expect(fetched).toBe(0)
  })

  test('a URL that is not Kiro is still passed through untouched', async () => {
    const handler = createHandler()
    let handled = false
    handler.handleKiroRequest = async () => {
      handled = true
      return new Response('handled', { status: 200 })
    }

    let fetched = 0
    globalThis.fetch = (async () => {
      fetched++
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const res = await handler.handle('https://api.openai.com/v1/chat/completions', {}, () => {})

    expect(fetched).toBe(1)
    expect(handled).toBe(false)
    expect(res.status).toBe(200)
  })
})
