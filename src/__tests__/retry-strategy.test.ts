import { describe, expect, test } from 'bun:test'
import { RetryStrategy } from '../core/request/retry-strategy.js'

// The real RetryStrategy, driven through its own createContext/shouldContinue/
// markSleep API — the same calls the request loop makes.

function strategy(maxIterations: number, timeoutMs: number): RetryStrategy {
  return new RetryStrategy({
    max_request_iterations: maxIterations,
    request_timeout_ms: timeoutMs
  })
}

describe('RetryStrategy.shouldContinue', () => {
  test('allows attempts up to the iteration ceiling, then stops with a reason', () => {
    const s = strategy(3, 60_000)
    const ctx = s.createContext()

    expect(s.shouldContinue(ctx)).toEqual({ canContinue: true })
    expect(s.shouldContinue(ctx)).toEqual({ canContinue: true })
    expect(s.shouldContinue(ctx)).toEqual({ canContinue: true })

    const stopped = s.shouldContinue(ctx)
    expect(stopped.canContinue).toBe(false)
    expect(stopped.error).toContain('max iterations')
  })

  test('stops once the elapsed time passes the timeout', () => {
    const s = strategy(1000, 50)
    const ctx = s.createContext()
    // Place the start in the past so the very first check is already over budget.
    ctx.startTime = Date.now() - 100

    const stopped = s.shouldContinue(ctx)
    expect(stopped.canContinue).toBe(false)
    expect(stopped.error).toBe('Request timeout')
  })

  test('excludes rate-limit sleeps from the timeout budget', () => {
    // A request that waited out a 429 must not have that wait counted against
    // its own timeout — markSleep is how the loop credits that time back.
    const s = strategy(1000, 50)
    const ctx = s.createContext()
    ctx.startTime = Date.now() - 100
    s.markSleep(ctx, 100)

    expect(s.shouldContinue(ctx)).toEqual({ canContinue: true })
  })

  test('markSleep never credits a negative amount', () => {
    const s = strategy(1000, 1000)
    const ctx = s.createContext()
    s.markSleep(ctx, -500)
    expect(ctx.excludedMs).toBe(0)
  })

  test('createContext starts a fresh, zeroed budget each time', () => {
    const s = strategy(5, 1000)
    const a = s.createContext()
    s.shouldContinue(a)
    s.markSleep(a, 10)

    const b = s.createContext()
    expect(b.iterations).toBe(0)
    expect(b.excludedMs).toBe(0)
  })
})
