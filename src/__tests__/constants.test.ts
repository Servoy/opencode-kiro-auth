import { describe, expect, test } from 'bun:test'
import { normalizeRegion, SUPPORTED_MODELS } from '../constants.js'
import { MODEL_SPECS } from '../plugin/model-registry.js'

describe('SUPPORTED_MODELS', () => {
  test('offers the -1m slugs only as aliases, never as models of their own', () => {
    // They resolve so a saved opencode.json keeps working, but nothing advertises
    // them: Kiro serves one model per family and the 1M window is that model's.
    expect(SUPPORTED_MODELS.filter((model) => model.includes('-1m')).length).toBeGreaterThan(0)
    for (const id of Object.keys(MODEL_SPECS)) {
      expect(id).not.toContain('-1m')
    }
  })
})

describe('normalizeRegion', () => {
  test('accepts configured AWS regions with the installed Zod enum shape', () => {
    expect(normalizeRegion('us-west-2')).toBe('us-west-2')
  })
})
