import { afterEach, describe, expect, test } from 'bun:test'
import type { ModelCapabilities } from '../plugin/models.js'
import { resetModelCatalog } from '../plugin/models.js'
import { RequestFieldsProfile } from '../plugin/request-fields-profile.js'

function caps(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return { supportsRequestFields: true, ...overrides }
}

afterEach(() => {
  resetModelCatalog()
})

describe('the built-in profile', () => {
  test('puts a GPT model on reasoning with none as off', () => {
    const profile = RequestFieldsProfile.fromBuiltIn('gpt-5.6-terra')

    expect(profile.channel).toBe('reasoning')
    expect(profile.offChannel).toBe('none')
    expect(profile.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(profile.acceptsBlock).toBe(true)
  })

  test('keeps Claude on output_config with no off', () => {
    const profile = RequestFieldsProfile.fromBuiltIn('claude-sonnet-5')

    expect(profile.channel).toBe('output_config')
    expect(profile.offChannel).toBeUndefined()
    expect(profile.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  test('gives no dial to a model the lists do not know', () => {
    const profile = RequestFieldsProfile.fromBuiltIn('kimi-k3')

    expect(profile.hasDial()).toBe(false)
    expect(profile.efforts).toEqual([])
  })

  test('sends xhigh as max where the model lacks xhigh', () => {
    const profile = RequestFieldsProfile.fromBuiltIn('claude-sonnet-4.6')

    expect(profile.efforts).toEqual(['low', 'medium', 'high', 'max'])
    expect(profile.resolveEffort('xhigh')).toBe('max')
  })

  test('always allows max_tokens', () => {
    expect(RequestFieldsProfile.fromBuiltIn('claude-sonnet-5').maxTokensCeiling).toBe(
      Number.POSITIVE_INFINITY
    )
  })
})

describe('the catalog profile', () => {
  test('takes the channel the schema names', () => {
    const profile = RequestFieldsProfile.fromCatalog(
      caps({ effortChannel: 'reasoning', efforts: ['low', 'high', 'max'] })
    )

    expect(profile.channel).toBe('reasoning')
    expect(profile.efforts).toEqual(['low', 'high', 'max'])
  })

  test('fits a level outside the enum to the nearest one below', () => {
    const profile = RequestFieldsProfile.fromCatalog(
      caps({ effortChannel: 'reasoning', efforts: ['low', 'high', 'max'] })
    )

    expect(profile.resolveEffort('medium')).toBe('low')
    expect(profile.resolveEffort('xhigh')).toBe('high')
    expect(profile.resolveEffort('max')).toBe('max')
  })

  test('falls back to the lowest level when none is below', () => {
    const profile = RequestFieldsProfile.fromCatalog(
      caps({ effortChannel: 'reasoning', efforts: ['high', 'max'] })
    )

    expect(profile.resolveEffort('low')).toBe('high')
  })

  test('drops values that are not effort levels', () => {
    const profile = RequestFieldsProfile.fromCatalog(
      caps({ effortChannel: 'reasoning', efforts: ['none', 'low'] })
    )

    expect(profile.efforts).toEqual(['low'])
  })

  test('keeps max_tokens only when the schema has it', () => {
    const without = RequestFieldsProfile.fromCatalog(caps({ acceptsMaxTokens: false }))
    const withCeiling = RequestFieldsProfile.fromCatalog(
      caps({ acceptsMaxTokens: true, maxTokensCeiling: 128000, maxOutputTokens: 64000 })
    )
    const withoutCeiling = RequestFieldsProfile.fromCatalog(
      caps({ acceptsMaxTokens: true, maxOutputTokens: 64000 })
    )

    expect(without.maxTokensCeiling).toBeUndefined()
    expect(withCeiling.maxTokensCeiling).toBe(64000)
    expect(withoutCeiling.maxTokensCeiling).toBe(64000)
  })

  test('treats a model the schema rejects as no block', () => {
    const profile = RequestFieldsProfile.fromCatalog(caps({ supportsRequestFields: false }))
    expect(profile.acceptsBlock).toBe(false)
  })

  test('never hands back none as a level', () => {
    const profile = RequestFieldsProfile.fromCatalog(
      caps({ effortChannel: 'reasoning', efforts: ['none', 'low', 'max'] })
    )

    expect(profile.resolveEffort('low')).toBe('low')
    expect(profile.resolveEffort('none' as any)).toBe('low')
    expect(profile.efforts).not.toContain('none')
  })
})

describe('picking the source', () => {
  test('uses the catalog when it knows the model and the built-in lists otherwise', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          models: [
            {
              modelId: 'claude-sonnet-5',
              additionalModelRequestFieldsSchema: {
                properties: {
                  output_config: { properties: { effort: { enum: ['low', 'high'] } } }
                },
                additionalProperties: false
              }
            }
          ]
        }),
        { status: 200 }
      )) as unknown as typeof fetch
    try {
      const { refreshModelCatalog } = await import('../plugin/models.js')
      await refreshModelCatalog({
        access: 'a',
        refresh: 'r',
        expires: 0,
        authMethod: 'idc',
        region: 'eu-central-1'
      } as any)

      expect(RequestFieldsProfile.forModel('claude-sonnet-5').efforts).toEqual(['low', 'high'])
      expect(RequestFieldsProfile.forModel('claude-sonnet-4.6').efforts).toEqual([
        'low',
        'medium',
        'high',
        'max'
      ])
    } finally {
      globalThis.fetch = original
    }
  })
})
