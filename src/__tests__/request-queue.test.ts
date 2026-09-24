import { describe, expect, mock, test } from 'bun:test'

const warnings: string[] = []

mock.module('../plugin/logger.js', () => ({
  debug: () => {},
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

    const first = handler.enqueueKiroRequest('acc-1', async () => {
      await new Promise((r) => setTimeout(r, 30))
      order.push('first')
      return 'a'
    })
    const second = handler.enqueueKiroRequest('acc-1', async () => {
      order.push('second')
      return 'b'
    })

    await Promise.all([first, second])
    expect(order).toEqual(['first', 'second'])
  })

  test('a request that never settles no longer wedges the whole process', async () => {
    warnings.length = 0
    // Floor is 30s, so use the minimum and shorten the wait by racing it.
    const handler = createHandler(30_000)
    handler.queueWaitMs = () => 40

    let stuckReleased = false
    const stuck = handler.enqueueKiroRequest(
      'acc-1',
      () =>
        new Promise(() => {
          stuckReleased = false
        })
    )
    void stuck

    const after = await handler.enqueueKiroRequest('acc-1', async () => 'went through')

    expect(after).toBe('went through')
    expect(stuckReleased).toBe(false)
    expect(warnings.some((w) => w.includes('proceeding in parallel'))).toBe(true)
  })

  test('the wait never drops below half a minute', () => {
    expect(createHandler(1_000).queueWaitMs()).toBe(30_000)
    expect(createHandler(300_000).queueWaitMs()).toBe(300_000)
  })
})

describe("lanes keep accounts out of each other's way", () => {
  test('two accounts run side by side instead of end to end', async () => {
    // A single lane made a fan-out of subagents run sequentially even when
    // each had its own account, which is the reason to have a second one.
    const handler = createHandler(120_000)
    const order: string[] = []
    let releaseA!: () => void
    const blocked = new Promise<void>((resolve) => {
      releaseA = resolve
    })

    const a = handler.enqueueKiroRequest('acc-a', async () => {
      order.push('a-start')
      await blocked
      order.push('a-end')
    })
    const b = handler.enqueueKiroRequest('acc-b', async () => {
      order.push('b-ran')
    })

    await b
    expect(order).toEqual(['a-start', 'b-ran'])

    releaseA()
    await a
    expect(order).toEqual(['a-start', 'b-ran', 'a-end'])
  })

  test('one account still runs its requests in order', async () => {
    const handler = createHandler(120_000)
    const order: string[] = []
    let releaseFirst!: () => void
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = handler.enqueueKiroRequest('acc-a', async () => {
      order.push('first-start')
      await blocked
      order.push('first-end')
    })
    const second = handler.enqueueKiroRequest('acc-a', async () => {
      order.push('second')
    })

    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })
})

describe('sessions do not hold each other up', () => {
  /** The lane a request queues in, given what the store knows about it. */
  function laneFor(handler: any, sessionId?: string): string {
    return handler.queueLane(sessionId)
  }

  test('two fresh sessions get lanes of their own', async () => {
    // An orchestrator fans out subagents that have never run before, so none
    // of them has an account yet. Sharing one lane made that fan-out run one
    // at a time, which is exactly what the lanes exist to prevent.
    const handler = createHandler(120_000)
    const a = laneFor(handler, 'ses_a')
    const b = laneFor(handler, 'ses_b')

    expect(a).not.toBe(b)
  })

  test('a fan-out of fresh sessions overlaps instead of queueing', async () => {
    const handler = createHandler(120_000)
    let running = 0
    let peak = 0
    const release: Array<() => void> = []

    const work = ['ses_1', 'ses_2', 'ses_3', 'ses_4', 'ses_5'].map((session) =>
      handler.enqueueKiroRequest(laneFor(handler, session), async () => {
        running++
        peak = Math.max(peak, running)
        await new Promise<void>((resolve) => release.push(resolve))
        running--
      })
    )

    // Give every one of them a chance to start before any finishes.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(peak).toBe(5)

    for (const done of release) done()
    await Promise.all(work)
  })

  test('turns of one session still run in order', async () => {
    // Parallelism between sessions, never within one: a conversationId is only
    // valid on the account that made it, and a turn depends on the last.
    const handler = createHandler(120_000)
    const order: string[] = []
    let releaseFirst!: () => void
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const lane = laneFor(handler, 'ses_same')
    const first = handler.enqueueKiroRequest(lane, async () => {
      order.push('first-start')
      await blocked
      order.push('first-end')
    })
    const second = handler.enqueueKiroRequest(lane, async () => {
      order.push('second')
    })

    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })
})
