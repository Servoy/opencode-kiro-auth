import { describe, expect, mock, test } from 'bun:test'

const warnings: string[] = []

mock.module('../plugin/logger.js', () => ({
  debug: () => {},
  error: () => {},
  log: () => {},
  warn: (message: string) => {
    warnings.push(message)
  },
  getTimestamp: () => '2026-07-22T00:00:00.000Z',
  logApiError: () => {},
  logApiRequest: () => {},
  logApiResponse: () => {}
}))

const { RequestHandler } = await import('../core/request/request-handler.js')

function createHandler(requestTimeoutMs: number) {
  const accountManager: any = { getAccountCount: () => 2 }
  const config: any = {
    request_timeout_ms: requestTimeoutMs,
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

describe('the shared Kiro request queue', () => {
  test('runs queued requests in order while they settle', async () => {
    const handler = createHandler(120_000)
    const order: string[] = []

    const first = handler.enqueueKiroRequest(async () => {
      await new Promise((r) => setTimeout(r, 30))
      order.push('first')
      return 'a'
    })
    const second = handler.enqueueKiroRequest(async () => {
      order.push('second')
      return 'b'
    })

    await Promise.all([first, second])
    expect(order).toEqual(['first', 'second'])
  })

  test('a request that never settles no longer wedges the whole process', async () => {
    // A single stuck request used to hold the static queue promise forever, so
    // every later request in the process waited on it with nothing in the log.
    // The queue only spreads rate limits across accounts — losing its ordering
    // beats deadlocking the provider.
    warnings.length = 0
    // Floor is 30s, so use the minimum and shorten the wait by racing it.
    const handler = createHandler(30_000)
    handler.queueWaitMs = () => 40

    let stuckReleased = false
    const stuck = handler.enqueueKiroRequest(
      () =>
        new Promise(() => {
          stuckReleased = false
        })
    )
    void stuck

    const after = await handler.enqueueKiroRequest(async () => 'went through')

    expect(after).toBe('went through')
    expect(stuckReleased).toBe(false)
    expect(warnings.some((w) => w.includes('proceeding in parallel'))).toBe(true)
  })

  test('the wait never drops below half a minute', () => {
    expect(createHandler(1_000).queueWaitMs()).toBe(30_000)
    expect(createHandler(300_000).queueWaitMs()).toBe(300_000)
  })
})
