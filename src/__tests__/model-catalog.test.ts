import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('../plugin/logger.js', () => ({
  debug: () => {},
  error: () => {},
  log: () => {},
  warn: () => {},
  getTimestamp: () => '2026-07-22T00:00:00.000Z',
  logApiError: () => {},
  logApiRequest: () => {},
  logApiResponse: () => {}
}))

const { getCatalogContextLimit, refreshModelCatalog, resetModelCatalog } =
  await import('../plugin/models.js')
const { getModelContextLimit } = await import('../plugin/model-registry.js')

const auth: any = { region: 'eu-central-1', access: 'token' }
const originalFetch = globalThis.fetch

function stubCatalog(body: unknown, status = 200): { calls: number } {
  const state = { calls: 0 }
  globalThis.fetch = (async () => {
    state.calls++
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return state
}

const CATALOG = {
  models: [
    { modelId: 'claude-sonnet-5', tokenLimits: { maxInputTokens: 200000 } },
    { modelId: 'claude-sonnet-5-1m', tokenLimits: { maxInputTokens: 1000000 } },
    { modelId: 'claude-haiku-4.5', tokenLimits: { maxInputTokens: 200000 } }
  ]
}

beforeEach(() => {
  resetModelCatalog()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  resetModelCatalog()
})

describe('discovering context windows', () => {
  test('the window the service reports wins over the built-in table', async () => {
    stubCatalog(CATALOG)
    await refreshModelCatalog(auth)

    expect(getCatalogContextLimit('claude-sonnet-5')).toBe(200000)
    expect(getModelContextLimit('claude-sonnet-5')).toBe(200000)
  })

  test('a -thinking id resolves through its base model', async () => {
    stubCatalog(CATALOG)
    await refreshModelCatalog(auth)

    expect(getCatalogContextLimit('claude-sonnet-5-thinking')).toBe(200000)
  })

  test('a model the catalog omits keeps its built-in limit', async () => {
    stubCatalog(CATALOG)
    await refreshModelCatalog(auth)

    expect(getCatalogContextLimit('claude-opus-5')).toBeUndefined()
    expect(getModelContextLimit('claude-opus-5')).toBe(1000000)
  })

  test('nothing is discovered before the first refresh', () => {
    expect(getCatalogContextLimit('claude-sonnet-5')).toBeUndefined()
    expect(getModelContextLimit('claude-sonnet-5')).toBe(1000000)
  })
})

describe('when discovery does not work', () => {
  test('an error leaves the built-in limits in place', async () => {
    stubCatalog({ message: 'nope' }, 403)
    await refreshModelCatalog(auth)

    expect(getCatalogContextLimit('claude-sonnet-5')).toBeUndefined()
    expect(getModelContextLimit('claude-sonnet-5')).toBe(1000000)
  })

  test('an empty catalog is treated as no answer, not as zero', async () => {
    stubCatalog({ models: [] })
    await refreshModelCatalog(auth)

    expect(getCatalogContextLimit('claude-sonnet-5')).toBeUndefined()
  })

  test('entries without a token limit are skipped', async () => {
    stubCatalog({ models: [{ modelId: 'claude-sonnet-5' }, ...CATALOG.models.slice(2)] })
    await refreshModelCatalog(auth)

    expect(getCatalogContextLimit('claude-sonnet-5')).toBeUndefined()
    expect(getCatalogContextLimit('claude-haiku-4-5')).toBe(200000)
  })
})

describe('how often it asks', () => {
  test("a second account gets its own limits, not the first one's", async () => {
    const state = stubCatalog(CATALOG)
    await refreshModelCatalog(auth)

    globalThis.fetch = (async () => {
      state.calls++
      return new Response(
        JSON.stringify({
          models: [{ modelId: 'claude-sonnet-5', tokenLimits: { maxInputTokens: 1000000 } }]
        }),
        { status: 200 }
      )
    }) as unknown as typeof fetch

    await refreshModelCatalog({ ...auth, profileArn: 'arn:aws:codewhisperer:eu-central-1:9:p/B' })

    expect(state.calls).toBe(2)
    expect(getCatalogContextLimit('claude-sonnet-5')).toBe(1000000)
  })

  test('the answer is cached rather than refetched per request', async () => {
    const state = stubCatalog(CATALOG)

    await refreshModelCatalog(auth)
    await refreshModelCatalog(auth)
    await refreshModelCatalog(auth)

    expect(state.calls).toBe(1)
  })

  test('concurrent callers share one request', async () => {
    const state = stubCatalog(CATALOG)

    await Promise.all([refreshModelCatalog(auth), refreshModelCatalog(auth)])

    expect(state.calls).toBe(1)
  })
})
