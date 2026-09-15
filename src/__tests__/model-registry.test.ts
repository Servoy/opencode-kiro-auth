import { describe, expect, test } from 'bun:test'
import { SUPPORTED_MODELS } from '../constants.js'
import type { Effort } from '../plugin/config/schema.js'
import { THINKING_BUDGETS } from '../plugin/effort.js'
import { buildModelRegistry } from '../plugin/model-registry.js'
import { resolveKiroModel } from '../plugin/models.js'

const registry = buildModelRegistry() as Record<string, any>

/** The models that carry an effort dial. */
const thinkingIDs = Object.keys(registry).filter((id) => registry[id].variants)
const XHIGH_MODELS = ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5']

describe('model registry', () => {
  test('every advertised model is resolvable to a Kiro model ID', () => {
    for (const modelID of Object.keys(registry)) {
      expect(SUPPORTED_MODELS).toContain(modelID)
    }
  })

  test('gives an effort dial to each effort-capable Claude model', () => {
    expect(thinkingIDs.sort()).toEqual(
      [
        'claude-opus-4-5',
        'claude-opus-4-6',
        'claude-opus-4-7',
        'claude-opus-4-8',
        'claude-opus-5',
        'claude-sonnet-4-5',
        'claude-sonnet-4-6',
        'claude-sonnet-5'
      ].sort()
    )
  })

  test('advertises no -thinking twins', () => {
    // The dial replaced them. They stay resolvable for configs that still name
    // one, but a duplicate entry per model is noise in the picker.
    for (const id of Object.keys(registry)) {
      expect(id.endsWith('-thinking')).toBe(false)
    }
  })

  test('does not advertise Kiro GPT tiers, which use a different reasoning contract', () => {
    for (const id of Object.keys(registry)) {
      expect(id.startsWith('gpt-')).toBe(false)
    }
  })

  describe('reasoning capability flags', () => {
    // Both are required: `reasoning` declares the capability, `interleaved.field`
    // tells OpenCode reasoning arrives as `reasoning_content` deltas. Missing
    // either one means reasoning chunks are silently dropped.
    test('every thinking model declares reasoning and the reasoning_content field', () => {
      for (const id of thinkingIDs) {
        expect(registry[id].reasoning).toBe(true)
        expect(registry[id].interleaved).toEqual({ field: 'reasoning_content' })
      }
    })

    test('a model with an effort dial declares them too', () => {
      // Picking a variant is what makes the model reason, so the capability
      // belongs to any model that offers one — not only to the -thinking twin.
      for (const [, model] of Object.entries(registry)) {
        if (!model.variants) continue
        expect(model.reasoning).toBe(true)
        expect(model.interleaved).toEqual({ field: 'reasoning_content' })
      }
    })

    test('a model without one declares neither', () => {
      for (const [, model] of Object.entries(registry)) {
        if (model.variants) continue
        expect(model.reasoning).toBeUndefined()
        expect(model.interleaved).toBeUndefined()
      }
    })
  })

  describe('thinking variants', () => {
    test('offers xhigh only on models Kiro documents as xhigh-capable', () => {
      for (const id of thinkingIDs) {
        const hasXHigh = Object.keys(registry[id].variants).includes('xhigh')
        expect(hasXHigh).toBe(XHIGH_MODELS.includes(id))
      }
    })

    test('offers off as the first position on the dial', () => {
      // Picking nothing is not off: the service then applies its own default,
      // which the catalog reports as high. Off has to be asked for.
      for (const id of thinkingIDs) {
        const names = Object.keys(registry[id].variants)
        expect(names[0]).toBe('off')
        expect(registry[id].variants.off).toEqual({ reasoningEffort: 'off' })
      }
    })

    test('a variant names the effort it selects', () => {
      // OpenCode hands the variant body back as providerOptions, so the value
      // it carries is what the request handler reads.
      for (const id of thinkingIDs) {
        for (const [name, variant] of Object.entries<any>(registry[id].variants)) {
          expect(variant).toEqual({ reasoningEffort: name })
        }
      }
    })

    test('variants are ordered low to max', () => {
      for (const id of thinkingIDs) {
        const levels = Object.keys(registry[id].variants).filter((n) => n !== 'off') as Effort[]
        const budgets = levels.map((l) => THINKING_BUDGETS[l])
        expect(budgets).toEqual([...budgets].sort((a, b) => a - b))
      }
    })

    test('a legacy -thinking id still resolves to its model', () => {
      // Dropping the entry must not break a config that names one.
      expect(resolveKiroModel('claude-sonnet-5-thinking')).toBe(resolveKiroModel('claude-sonnet-5'))
    })
  })

  test('carries limit and modalities', () => {
    expect(registry['claude-opus-5'].limit).toEqual({ context: 1000000, output: 128000 })
    expect(registry['claude-opus-5'].modalities).toBeDefined()
  })
})

describe('quota in the model name', () => {
  test('the suffix reaches the model name', () => {
    const r = buildModelRegistry('· 13%') as Record<string, { name: string }>
    expect(r['claude-sonnet-5']!.name).toBe('Claude Sonnet 5 (1.3x) · 13%')
  })

  test('no suffix leaves the names exactly as they were', () => {
    const r = buildModelRegistry() as Record<string, { name: string }>
    expect(r['claude-sonnet-5']!.name).toBe('Claude Sonnet 5 (1.3x)')
  })
})

describe('sampling controls', () => {
  test('no model claims temperature', () => {
    // The service has no such field: kiro-cli sends none, and the effort
    // schema it advertises covers output_config, thinking and max_tokens only.
    for (const [, model] of Object.entries(registry)) {
      expect(model.temperature).toBe(false)
    }
  })
})

describe('the quota shown in a model name', () => {
  test('a later percentage replaces the earlier one, in place', () => {
    // The registry is built once at startup, so the percentage baked into the
    // names froze there — it still read 13% after a morning's work took it to
    // 14.5%. Names are rewritten on the object OpenCode was handed; whether it
    // re-reads them is its own business, but the value it holds is current.
    const models = buildModelRegistry('· 13%') as Record<string, { name: string }>
    const before = models['claude-sonnet-5']!.name
    expect(before).toContain('· 13%')

    for (const model of Object.values(models)) {
      model.name = model.name.replace('· 13%', '· 14%')
    }

    expect(models['claude-sonnet-5']!.name).toBe(before.replace('· 13%', '· 14%'))
    expect(models['claude-sonnet-5']!.name).not.toContain('13%')
  })

  test('a name carries the suffix exactly once', () => {
    // Appending instead of replacing would grow the name on every refresh.
    const models = buildModelRegistry('· 13%') as Record<string, { name: string }>
    for (const model of Object.values(models)) {
      expect(model.name.match(/· 13%/g)).toHaveLength(1)
    }
  })
})
