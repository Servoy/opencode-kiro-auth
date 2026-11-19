import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_MODEL_FALLBACKS,
  isModelCapacityError,
  nextFallbackModel
} from '../plugin/model-fallback.js'

const servesEverything = () => true

describe('isModelCapacityError', () => {
  test('recognises the capacity reasons Kiro sends, however they are spelled', () => {
    expect(isModelCapacityError('MODEL_TEMPORARILY_UNAVAILABLE')).toBe(true)
    expect(isModelCapacityError('ModelTemporarilyUnavailable')).toBe(true)
    expect(
      isModelCapacityError(
        'The service is temporarily unavailable. (MODEL_TEMPORARILY_UNAVAILABLE)'
      )
    ).toBe(true)
    expect(isModelCapacityError('INSUFFICIENT_MODEL_CAPACITY')).toBe(true)
  })

  test('leaves failures that are not the model alone', () => {
    // Throttling and plain server errors are about this account or Kiro as a
    // whole; answering them by changing model spends a second model's capacity
    // on a problem it cannot fix.
    expect(isModelCapacityError('ThrottlingException')).toBe(false)
    expect(isModelCapacityError('Internal Server Error')).toBe(false)
    expect(isModelCapacityError('Service Unavailable')).toBe(false)
    expect(isModelCapacityError('Invalid model ID')).toBe(false)
    expect(isModelCapacityError('')).toBe(false)
    expect(isModelCapacityError(undefined)).toBe(false)
  })
})

describe('nextFallbackModel', () => {
  const chains = { a: ['b', 'c'], b: ['c'] }

  test('offers the first model in the chain', () => {
    expect(nextFallbackModel('a', chains, new Set(['a']), servesEverything)).toBe('b')
  })

  test('skips a model this request was already refused by', () => {
    expect(nextFallbackModel('a', chains, new Set(['a', 'b']), servesEverything)).toBe('c')
  })

  test('skips a model the account is not served', () => {
    expect(nextFallbackModel('a', chains, new Set(['a']), (m) => m !== 'b')).toBe('c')
  })

  test('gives up when nothing in the chain is left', () => {
    expect(
      nextFallbackModel('a', chains, new Set(['a', 'b', 'c']), servesEverything)
    ).toBeUndefined()
  })

  test('a model with no chain has no fallback', () => {
    expect(nextFallbackModel('z', chains, new Set(['z']), servesEverything)).toBeUndefined()
  })

  test('answers a thinking request with a thinking model', () => {
    // Dropping the suffix would silently take reasoning away from a turn that
    // asked for it, which is a different answer, not a fallback.
    expect(nextFallbackModel('a-thinking', chains, new Set(['a-thinking']), servesEverything)).toBe(
      'b-thinking'
    )
  })

  test('an empty chain map turns the whole policy off', () => {
    expect(nextFallbackModel('a', {}, new Set(['a']), servesEverything)).toBeUndefined()
  })

  test('records its answer, so the next hop cannot offer it again', () => {
    const tried = new Set(['a'])
    expect(nextFallbackModel('a', chains, tried, servesEverything)).toBe('b')
    expect(tried.has('b')).toBe(true)
  })

  test('walking a chain always terminates, whatever the chain looks like', () => {
    // The property that matters: a hand-written chain may loop back on itself
    // or point at a model that points back. Walking it must always stop.
    const models = ['m0', 'm1', 'm2', 'm3', 'm4']
    for (let seed = 0; seed < 200; seed++) {
      let rnd = seed * 2654435761
      const next = () => {
        rnd = (rnd * 1103515245 + 12345) & 0x7fffffff
        return rnd
      }
      const generated: Record<string, string[]> = {}
      for (const m of models) {
        const size = next() % (models.length + 1)
        generated[m] = Array.from({ length: size }, () => models[next() % models.length]!)
      }

      let current = 'm0'
      const tried = new Set([current])
      let hops = 0
      for (;;) {
        const fallback = nextFallbackModel(current, generated, tried, servesEverything)
        if (!fallback) break
        current = fallback
        hops++
        expect(hops).toBeLessThanOrEqual(models.length)
      }
    }
  })
})

describe('the built-in chains', () => {
  test('never leave a family, so a fallback cannot change what a turn costs', () => {
    const family = (id: string) => id.split('-').slice(0, 2).join('-')
    for (const [from, targets] of Object.entries(DEFAULT_MODEL_FALLBACKS)) {
      for (const to of targets) {
        expect(family(to)).toBe(family(from))
      }
    }
  })

  test('point only at models the plugin can resolve', async () => {
    const { MODEL_MAPPING } = await import('../constants.js')
    for (const [from, targets] of Object.entries(DEFAULT_MODEL_FALLBACKS)) {
      expect(MODEL_MAPPING[from]).toBeDefined()
      for (const to of targets) expect(MODEL_MAPPING[to]).toBeDefined()
    }
  })

  test('terminate — no chain loops back to where it started', () => {
    for (const start of Object.keys(DEFAULT_MODEL_FALLBACKS)) {
      let current = start
      const tried = new Set([current])
      for (let hop = 0; hop <= Object.keys(DEFAULT_MODEL_FALLBACKS).length; hop++) {
        const fallback = nextFallbackModel(
          current,
          DEFAULT_MODEL_FALLBACKS,
          tried,
          servesEverything
        )
        if (!fallback) break
        tried.add(fallback)
        current = fallback
        expect(current).not.toBe(start)
      }
    }
  })
})
