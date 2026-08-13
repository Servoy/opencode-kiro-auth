import { describe, expect, test } from 'bun:test'
import { buildModelRegistry, getModelContextLimit } from '../plugin/model-registry'

/**
 * The registry advertises a context limit to OpenCode; the streaming transformers multiply Kiro's
 * context-usage percentage by their own limit to derive input tokens. When those two numbers differ,
 * OpenCode's token accounting — and therefore when it compacts — is wrong.
 *
 * They differed for every model whose id lacks a literal `-1m`: advertised 1M, used 200K.
 */
describe('context limit: one number per model', () => {
  const registry = buildModelRegistry() as Record<string, { limit: { context: number } }>

  test('every advertised model resolves to the same limit internally', () => {
    const ids = Object.keys(registry)
    expect(ids.length).toBeGreaterThan(10)
    for (const id of ids) {
      expect(getModelContextLimit(id)).toBe(registry[id]!.limit.context)
    }
  })

  test('the advertised limit and the internally used limit are the same number', () => {
    for (const id of [
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-sonnet-5-thinking',
      'claude-opus-5-thinking'
    ]) {
      const entry = registry[id]
      expect(entry).toBeDefined()
      expect(getModelContextLimit(id)).toBe(entry!.limit.context)
    }
  })

  test('a -thinking id inherits its base model limit', () => {
    for (const id of Object.keys(registry).filter((k) => k.endsWith('-thinking'))) {
      expect(getModelContextLimit(id)).toBe(getModelContextLimit(id.replace(/-thinking$/, '')))
    }
  })

  test('an unknown model falls back to 200K rather than NaN', () => {
    expect(getModelContextLimit('not-a-model')).toBe(200000)
  })
})
