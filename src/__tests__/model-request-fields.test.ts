import { describe, expect, test } from 'bun:test'
import { buildModelRequestFields, EFFORT_OFF } from '../plugin/model-request-fields.js'

describe('the additionalModelRequestFields block', () => {
  test('says nothing when there is nothing to say', () => {
    // An absent block lets the service apply its own default, which is what
    // should happen when the user has expressed no preference.
    expect(buildModelRequestFields('claude-sonnet-5', undefined, false)).toBeUndefined()
  })

  test('puts a Claude effort under output_config', () => {
    expect(buildModelRequestFields('claude-sonnet-5', 'high', false)).toEqual({
      output_config: { effort: 'high' }
    })
  })

  test('puts a GPT effort under reasoning instead', () => {
    // The service reads one channel or the other, never both.
    const fields = buildModelRequestFields('gpt-5.6-terra', 'high', false)
    expect(fields).toEqual({ reasoning: { effort: 'high' } })
    expect(fields?.output_config).toBeUndefined()
  })

  test('off disables thinking rather than asking for less of it', () => {
    // No live catalog here, so there is no confirmed channel to send.
    expect(buildModelRequestFields('claude-sonnet-5', 'low', true)).toBeUndefined()
  })

  test('off wins over any effort that came with it', () => {
    const fields = buildModelRequestFields('claude-sonnet-5', 'max', true)
    expect(fields?.output_config).toBeUndefined()
    expect(fields?.reasoning).toBeUndefined()
  })

  test('off on a GPT model names reasoning none, not the Claude thinking switch', () => {
    // GPT has no thinking.type field; its off is reasoning.effort = none. The
    // Claude disabled switch would be a 400 before a single token.
    const fields = buildModelRequestFields('gpt-5.6-sol', 'max', true)
    expect(fields).toEqual({ reasoning: { effort: 'none' } })
    expect(fields?.thinking).toBeUndefined()
    expect(fields?.output_config).toBeUndefined()
  })

  test('a GPT model never emits the Claude thinking or output_config channels', () => {
    // One wrong channel 400s the whole request, so hold it at every dial
    // position the registry offers plus the absent one.
    for (const level of [undefined, 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      for (const disabled of [false, true]) {
        const fields = buildModelRequestFields('gpt-5.6-terra', level, disabled)
        expect(fields?.thinking).toBeUndefined()
        expect(fields?.output_config).toBeUndefined()
      }
    }
  })

  test('carries a max_tokens ceiling when one is asked for', () => {
    expect(buildModelRequestFields('claude-sonnet-5', undefined, false, 8000)).toEqual({
      max_tokens: 8000
    })
  })

  test('off is the name the dial uses', () => {
    expect(EFFORT_OFF).toBe('off')
  })
})

describe('off with a catalog-confirmed channel', () => {
  async function withChannel(kiroModel: string, enumValues: string[], run: () => void) {
    const { refreshModelCatalog, resetModelCatalog } = await import('../plugin/models.js')
    resetModelCatalog()
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          models: [
            {
              modelId: kiroModel,
              additionalModelRequestFieldsSchema: {
                properties: { thinking: { properties: { type: { enum: enumValues } } } }
              }
            }
          ]
        }),
        { status: 200 }
      )) as unknown as typeof fetch
    try {
      await refreshModelCatalog({
        access: 'a',
        refresh: 'r',
        expires: 0,
        authMethod: 'idc',
        region: 'eu-central-1'
      } as any)
      run()
    } finally {
      globalThis.fetch = original
      resetModelCatalog()
    }
  }

  test('disabled pins effort to the ceiling', async () => {
    await withChannel('claude-sonnet-5', ['adaptive', 'disabled'], () => {
      expect(buildModelRequestFields('claude-sonnet-5', 'xhigh', true)).toEqual({
        thinking: { type: 'disabled' },
        output_config: { effort: 'high' }
      })
    })
  })

  test('between_tools in the enum still emits no block (confirmed 400 live)', async () => {
    await withChannel('claude-sonnet-5.5', ['adaptive', 'between_tools'], () => {
      expect(buildModelRequestFields('claude-sonnet-5.5', 'max', true)).toBeUndefined()
    })
  })

  test('no off value in the enum emits no block at all', async () => {
    await withChannel('claude-opus-5.5', ['adaptive'], () => {
      expect(buildModelRequestFields('claude-opus-5.5', 'max', true)).toBeUndefined()
    })
  })
})
