import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const warnings: string[] = []
mock.module('../plugin/logger.js', () => ({
  debug: () => {},
  error: () => {},
  log: () => {},
  setDebugEnabled: () => {},
  getTimestamp: () => '2026-10-09T00:00:00.000Z',
  logApiError: () => {},
  logApiRequest: () => {},
  logApiResponse: () => {},
  warn: (message: string) => {
    warnings.push(message)
  }
}))

const catalogModule = await import('../plugin/models.js')
const { canDisableThinking } = await import('../plugin/model-request-fields.js')

const auth: any = { region: 'eu-central-1', access: 'token', profileArn: 'arn' }
const originalFetch = globalThis.fetch

function stubCatalog(models: unknown[]) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ models }), { status: 200 })) as unknown as typeof fetch
}

beforeEach(() => {
  warnings.length = 0
  catalogModule.resetModelCatalog()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  catalogModule.resetModelCatalog()
})

describe('whether a model can actually be told not to reason', () => {
  // Measured against the live service: `thinking: {type: "disabled"}` does stop
  // reasoning (Opus 5 went from 288/494 characters to 0/0), so a model that
  // advertises the channel is genuinely switchable and one that does not is not.
  // Opus 5.5's enum is ["adaptive"] alone, and Sonnet 5.5's only other value
  // answers "Improperly formed request", so for both the off setting is a no-op.
  test('a Claude model with no disable channel in its schema cannot be switched off', async () => {
    stubCatalog([
      {
        modelId: 'claude-opus-5.5',
        tokenLimits: { maxInputTokens: 1000000 },
        additionalModelRequestFieldsSchema: {
          properties: { thinking: { properties: { type: { enum: ['adaptive'] } } } }
        }
      }
    ])
    await catalogModule.refreshModelCatalog(auth)

    expect(canDisableThinking('claude-opus-5.5')).toBe(false)
  })

  test('a Claude model that advertises the channel can be switched off', async () => {
    stubCatalog([
      {
        modelId: 'claude-opus-5',
        tokenLimits: { maxInputTokens: 1000000 },
        additionalModelRequestFieldsSchema: {
          properties: { thinking: { properties: { type: { enum: ['adaptive', 'disabled'] } } } }
        }
      }
    ])
    await catalogModule.refreshModelCatalog(auth)

    expect(canDisableThinking('claude-opus-5')).toBe(true)
  })

  test('GPT switches off through reasoning.effort none', () => {
    expect(canDisableThinking('gpt-5.6-sol')).toBe(true)
  })

  test('says nothing about a model whose schema was never read', () => {
    // No catalog means no answer. Claiming a model cannot be switched off when
    // nobody has looked would turn a missing lookup into a wrong statement.
    expect(canDisableThinking('claude-opus-4-8')).toBeUndefined()
  })

  test('a model that takes no reasoning block at all has nothing to switch off', async () => {
    stubCatalog([{ modelId: 'claude-haiku-4.5', tokenLimits: { maxInputTokens: 200000 } }])
    await catalogModule.refreshModelCatalog(auth)

    expect(canDisableThinking('claude-haiku-4.5')).toBe(true)
  })

  test('warns once when a model is asked to stop reasoning and cannot', async () => {
    const { transformToSdkRequest } = await import('../plugin/request.js')
    stubCatalog([
      {
        modelId: 'claude-opus-5.5',
        tokenLimits: { maxInputTokens: 1000000 },
        additionalModelRequestFieldsSchema: {
          properties: { thinking: { properties: { type: { enum: ['adaptive'] } } } }
        }
      }
    ])
    await catalogModule.refreshModelCatalog(auth)

    const body = {
      model: 'claude-opus-5-5',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      stream: true,
      reasoning_effort: 'off'
    }
    const build = () =>
      transformToSdkRequest(
        body as any,
        'claude-opus-5-5',
        auth,
        false,
        20000,
        () => {},
        'w',
        true,
        undefined,
        5_000_000,
        true
      )

    build()
    build()

    expect(warnings.filter((w) => /cannot turn thinking off/i.test(w))).toHaveLength(1)
  })
})
