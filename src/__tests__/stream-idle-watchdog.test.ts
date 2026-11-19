import { describe, expect, test } from 'bun:test'
import {
  guardStreamIdle,
  idleWatchdogOptions,
  StreamIdleError
} from '../plugin/streaming/idle-watchdog.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * A source whose gap before each event is given, so stalls are reproducible.
 *
 * `return` is a plain method rather than a generator's implicit cleanup, so a
 * close is observed the moment the watchdog asks for it — a generator parked
 * in an await would only record it once that await settled, which is the very
 * delay the watchdog refuses to wait for.
 */
function sourceWithGaps(gaps: number[]): AsyncIterable<number> & { returned: number } {
  const state = {
    returned: 0,
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        async next(): Promise<IteratorResult<number>> {
          if (i >= gaps.length) return { done: true, value: undefined }
          await sleep(gaps[i]!)
          return { done: false, value: i++ }
        },
        async return(): Promise<IteratorResult<number>> {
          state.returned++
          return { done: true, value: undefined }
        }
      }
    }
  }
  return state
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of it) out.push(v)
  return out
}

describe('guardStreamIdle', () => {
  test('passes every event through, in order, when no gap exceeds the budget', async () => {
    const events = await collect(guardStreamIdle(sourceWithGaps([0, 1, 1, 0, 1]), { hardMs: 200 }))
    expect(events).toEqual([0, 1, 2, 3, 4])
  })

  test('throws StreamIdleError once a single gap exceeds the budget', async () => {
    const run = collect(guardStreamIdle(sourceWithGaps([0, 0, 300]), { hardMs: 60 }))
    await expect(run).rejects.toThrow(StreamIdleError)
  })

  test('reports the observed idle time, not the budget', async () => {
    let caught: unknown
    try {
      await collect(guardStreamIdle(sourceWithGaps([500]), { hardMs: 50 }))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(StreamIdleError)
    expect((caught as StreamIdleError).idleMs).toBeGreaterThanOrEqual(50)
    expect((caught as StreamIdleError).message).toContain('stream stalled')
  })

  test('measures each gap on its own, so a long stream of short gaps survives', async () => {
    // Ten 20ms gaps is 200ms in total against a 60ms budget: a watchdog that
    // timed the whole stream rather than each gap would kill this.
    const events = await collect(
      guardStreamIdle(sourceWithGaps([20, 20, 20, 20, 20, 20, 20, 20, 20, 20]), { hardMs: 60 })
    )
    expect(events).toHaveLength(10)
  })

  test('a slow consumer is not a stall', async () => {
    const guarded = guardStreamIdle(sourceWithGaps([0, 0, 0]), { hardMs: 40 })
    const events: number[] = []
    for await (const v of guarded) {
      events.push(v)
      await sleep(80)
    }
    expect(events).toEqual([0, 1, 2])
  })

  test('closes the upstream stream when it stalls, instead of parking the socket', async () => {
    const source = sourceWithGaps([300])
    await expect(collect(guardStreamIdle(source, { hardMs: 40 }))).rejects.toThrow(StreamIdleError)
    expect(source.returned).toBe(1)
  })

  test('closes the upstream stream when the consumer stops early', async () => {
    const source = sourceWithGaps([0, 0, 0])
    for await (const _ of guardStreamIdle(source, { hardMs: 200 })) break
    expect(source.returned).toBe(1)
  })

  test('reports a gap past the soft tier once, and stays silent under it', async () => {
    const seen: number[] = []
    await collect(
      guardStreamIdle(sourceWithGaps([80, 1, 1]), {
        hardMs: 1000,
        softMs: 30,
        onSoft: (ms) => seen.push(ms)
      })
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeGreaterThanOrEqual(30)
  })

  test('propagates an upstream failure unchanged', async () => {
    const source = {
      async *[Symbol.asyncIterator]() {
        yield 1
        throw new Error('upstream exploded')
      }
    }
    await expect(collect(guardStreamIdle(source, { hardMs: 500 }))).rejects.toThrow(
      'upstream exploded'
    )
  })

  test('without a budget the source is passed straight through', async () => {
    const events = await collect(guardStreamIdle(sourceWithGaps([60, 60]), { hardMs: 0 }))
    expect(events).toEqual([0, 1])
  })
})

describe('idleWatchdogOptions', () => {
  test('puts the soft tier at half the budget', () => {
    expect(idleWatchdogOptions(120000)).toEqual({ hardMs: 120000, softMs: 60000 })
  })

  test('a budget of zero or less means no watchdog', () => {
    expect(idleWatchdogOptions(0)).toBeUndefined()
    expect(idleWatchdogOptions(-1)).toBeUndefined()
  })

  test('a non-finite budget means no watchdog', () => {
    expect(idleWatchdogOptions(Number.NaN)).toBeUndefined()
    expect(idleWatchdogOptions(Number.POSITIVE_INFINITY)).toBeUndefined()
  })
})
