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

const catalogModule = await import('../plugin/models.js')
const { getCatalogContextLimit, refreshModelCatalog, resetModelCatalog } = catalogModule
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

describe('sharing across projects', () => {
  test('a second project reuses what the first fetched', async () => {
    // OpenCode gives each project its own module instance, so the answer is
    // shared through kiro.db rather than module state.
    const state = stubCatalog(CATALOG)
    await refreshModelCatalog(auth)
    expect(state.calls).toBe(1)

    // Same machine, fresh module state: what a second project looks like.
    catalogModule.resetMemoryOnly()
    await refreshModelCatalog(auth)

    expect(state.calls).toBe(1)
    expect(getCatalogContextLimit('claude-sonnet-5')).toBe(200000)
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

  test('a failed lookup backs off instead of retrying every request', async () => {
    // OpenCode instantiates the plugin per project. With dozens open, a
    // catalog that is down turned into a failed request per call.
    const state = stubCatalog({ message: 'nope' }, 400)

    await refreshModelCatalog(auth)
    await refreshModelCatalog(auth)
    await refreshModelCatalog(auth)

    expect(state.calls).toBe(1)
    expect(getCatalogContextLimit('claude-sonnet-5')).toBeUndefined()
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

describe('capabilities the catalog reports', () => {
  const CATALOG_ENTRY = {
    modelId: 'claude-sonnet-4.6',
    rateMultiplier: 1.3,
    tokenLimits: { maxInputTokens: 1000000, maxOutputTokens: 64000 },
    supportedInputTypes: ['TEXT', 'IMAGE'],
    promptCaching: {
      supportsPromptCaching: true,
      minimumTokensPerCacheCheckpoint: 1024,
      maximumCacheCheckpointsPerRequest: 4
    },
    additionalModelRequestFieldsSchema: {
      properties: {
        output_config: {
          properties: { effort: { enum: ['low', 'medium', 'high', 'max'], default: 'high' } }
        },
        thinking: { properties: { type: { enum: ['adaptive', 'disabled'] } } }
      }
    }
  }

  async function loadCatalog(entries: unknown[]) {
    const { refreshModelCatalog, resetModelCatalog, getCatalogCapabilities } =
      await import('../plugin/models.js')
    resetModelCatalog()
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ models: entries }), { status: 200 })) as unknown as typeof fetch
    try {
      await refreshModelCatalog({
        access: 'a',
        refresh: 'r',
        expires: 0,
        authMethod: 'idc',
        region: 'eu-central-1'
      } as any)
    } finally {
      globalThis.fetch = original
    }
    return getCatalogCapabilities
  }

  test('reads the effort levels out of the advertised schema', async () => {
    const caps = (await loadCatalog([CATALOG_ENTRY]))('claude-sonnet-4-6')
    expect(caps?.efforts).toEqual(['low', 'medium', 'high', 'max'])
    expect(caps?.supportsThinking).toBe(true)
  })

  test('reads prompt caching, which the service does support', async () => {
    // Kiro CLI sends no cache fields on a small request and KiroStudio
    // fabricates the numbers, but the catalog states the support outright.
    const caps = (await loadCatalog([CATALOG_ENTRY]))('claude-sonnet-4-6')
    expect(caps?.supportsCaching).toBe(true)
    expect(caps?.minCacheTokens).toBe(1024)
    expect(caps?.maxCacheCheckpoints).toBe(4)
  })

  test('lowercases the input modalities', async () => {
    const caps = (await loadCatalog([CATALOG_ENTRY]))('claude-sonnet-4-6')
    expect(caps?.inputTypes).toEqual(['text', 'image'])
  })

  test('a model without the schema reports no effort levels', async () => {
    // opus-4.5 and sonnet-4 are like this in the live catalog, while the
    // built-in list claims both support effort.
    const caps = (
      await loadCatalog([{ modelId: 'claude-opus-4.5', tokenLimits: { maxInputTokens: 200000 } }])
    )('claude-opus-4-5')
    expect(caps?.efforts).toBeUndefined()
  })
})

describe('models that reject additionalModelRequestFields', () => {
  async function loadAndBuild(entries: unknown[], model: string, maxTokens?: number) {
    const { refreshModelCatalog, resetModelCatalog } = await import('../plugin/models.js')
    const { buildModelRequestFields } = await import('../plugin/model-request-fields.js')
    resetModelCatalog()
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ models: entries }), {
        status: 200
      })) as unknown as typeof fetch
    try {
      await refreshModelCatalog({
        access: 'a',
        refresh: 'r',
        expires: 0,
        authMethod: 'idc',
        region: 'eu-central-1'
      } as any)
    } finally {
      globalThis.fetch = original
    }
    return buildModelRequestFields(model, undefined, false, maxTokens)
  }

  const WITH_SCHEMA = {
    modelId: 'claude-sonnet-4.6',
    tokenLimits: { maxOutputTokens: 64000 },
    additionalModelRequestFieldsSchema: {
      properties: { output_config: { properties: { effort: { enum: ['low', 'high'] } } } }
    }
  }
  const WITHOUT_SCHEMA = { modelId: 'claude-haiku-4.5', tokenLimits: { maxOutputTokens: 64000 } }

  test('sends nothing to a model with no schema, even when max_tokens is set', async () => {
    // OpenCode sends max_tokens on every call, so the block stopped being
    // empty and every request to such a model failed with a 400 before a
    // single token: "additionalModelRequestFields is not supported".
    expect(await loadAndBuild([WITHOUT_SCHEMA], 'claude-haiku-4.5', 32000)).toBeUndefined()
  })

  test('still sends to a model that advertises one', async () => {
    expect(await loadAndBuild([WITH_SCHEMA], 'claude-sonnet-4-6', 32000)).toEqual({
      max_tokens: 32000
    })
  })

  test('a model the catalog never mentioned keeps receiving the block', async () => {
    // Unknown is not the same as unsupported: a catalog that could not be read
    // must not silently strip the block from everything.
    expect(await loadAndBuild([WITH_SCHEMA], 'some-future-model', 32000)).toEqual({
      max_tokens: 32000
    })
  })
})

describe('a catalog cached by an older version', () => {
  test('is refetched rather than read back with fields it never had', async () => {
    // The row that caused this: written before supportsRequestFields existed,
    // still inside its TTL, so it was trusted — and the missing field read as
    // undefined, which is not the service saying no. Every haiku request kept
    // failing with a 400 after the fix had already shipped.
    const { kiroDb } = await import('../plugin/storage/sqlite.js')
    const { refreshModelCatalog, resetMemoryOnly, getCatalogCapabilities } =
      await import('../plugin/models.js')

    kiroDb.setModelCatalog(
      'eu-central-1:',
      { 'claude-haiku-4.5': { maxInputTokens: 200000 } },
      Date.now(),
      30 * 60 * 1000
    )
    resetMemoryOnly()

    let fetched = false
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      fetched = true
      return new Response(
        JSON.stringify({ models: [{ modelId: 'claude-haiku-4.5', tokenLimits: {} }] }),
        { status: 200 }
      )
    }) as unknown as typeof fetch
    try {
      await refreshModelCatalog({
        access: 'a',
        refresh: 'r',
        expires: 0,
        authMethod: 'idc',
        region: 'eu-central-1'
      } as any)
    } finally {
      globalThis.fetch = original
    }

    expect(fetched).toBe(true)
    expect(getCatalogCapabilities('claude-haiku-4-5')?.supportsRequestFields).toBe(false)
  })
})

describe('a catalog that could not be fetched', () => {
  async function withFetch(failing: boolean, entries: unknown[] = []) {
    const { refreshModelCatalog, resetMemoryOnly, getCatalogCapabilities } =
      await import('../plugin/models.js')
    resetMemoryOnly()
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      if (failing) throw new Error('network is down')
      return new Response(JSON.stringify({ models: entries }), { status: 200 })
    }) as unknown as typeof fetch
    try {
      await refreshModelCatalog({
        access: 'a',
        refresh: 'r',
        expires: 0,
        authMethod: 'idc',
        region: 'eu-central-1'
      } as any)
    } finally {
      globalThis.fetch = original
    }
    return getCatalogCapabilities
  }

  const HAIKU = { modelId: 'claude-haiku-4.5', tokenLimits: { maxInputTokens: 200000 } }

  test('never replaces what another project already learned', async () => {
    // kiro.db is shared by every project on the machine. A cold start whose
    // first fetch fails used to write an empty map over a good row, and with
    // no catalog a model that rejects additionalModelRequestFields is sent it
    // again — the 400 this release was meant to end.
    await withFetch(false, [HAIKU])

    const afterFailure = await withFetch(true)
    expect(afterFailure('claude-haiku-4-5')?.supportsRequestFields).toBe(false)
  })

  test('a stored row carrying no models is not treated as an answer', async () => {
    const { kiroDb } = await import('../plugin/storage/sqlite.js')
    const { refreshModelCatalog, resetMemoryOnly, getCatalogCapabilities } =
      await import('../plugin/models.js')
    kiroDb.setModelCatalog('eu-central-1:', { __catalogVersion: 2 }, Date.now(), 5 * 60 * 1000)
    resetMemoryOnly()

    let fetched = false
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      fetched = true
      return new Response(JSON.stringify({ models: [HAIKU] }), { status: 200 })
    }) as unknown as typeof fetch
    try {
      await refreshModelCatalog({
        access: 'a',
        refresh: 'r',
        expires: 0,
        authMethod: 'idc',
        region: 'eu-central-1'
      } as any)
    } finally {
      globalThis.fetch = original
    }

    expect(fetched).toBe(true)
    expect(getCatalogCapabilities('claude-haiku-4-5')?.supportsRequestFields).toBe(false)
  })
})

describe('a catalog fetched on a stale token', () => {
  const AUTH = {
    access: 'stale',
    refresh: 'r',
    expires: 0,
    authMethod: 'idc',
    region: 'eu-central-1'
  } as any
  const HAIKU_MODEL = { modelId: 'claude-haiku-4.5', tokenLimits: { maxInputTokens: 200000 } }

  async function run(
    firstResponse: () => Response | Promise<Response>,
    recover?: () => Promise<any>
  ) {
    const { refreshModelCatalog, resetMemoryOnly, getCatalogCapabilities } =
      await import('../plugin/models.js')
    resetMemoryOnly()

    let calls = 0
    let recoverCalls = 0
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      calls++
      if (calls === 1) return await firstResponse()
      return new Response(JSON.stringify({ models: [HAIKU_MODEL] }), { status: 200 })
    }) as unknown as typeof fetch

    try {
      await refreshModelCatalog(
        AUTH,
        recover
          ? async () => {
              recoverCalls++
              return await recover()
            }
          : undefined
      )
    } finally {
      globalThis.fetch = original
    }
    return { calls, recoverCalls, getCatalogCapabilities }
  }

  test('403 forces a refresh once, then retries with the new token', async () => {
    const { calls, recoverCalls, getCatalogCapabilities } = await run(
      () => new Response('', { status: 403 }),
      async () => ({ ...AUTH, access: 'fresh' })
    )
    expect(calls).toBe(2)
    expect(recoverCalls).toBe(1)
    expect(getCatalogCapabilities('claude-haiku-4-5')?.maxInputTokens).toBe(200000)
  })

  test('400 Invalid token is treated as a stale token and retried', async () => {
    const { calls, recoverCalls } = await run(
      () =>
        new Response(
          JSON.stringify({
            __type: 'com.amazon.kiro.controlplane#AccessDeniedException',
            message: 'Invalid token'
          }),
          { status: 400 }
        ),
      async () => ({ ...AUTH, access: 'fresh' })
    )
    expect(calls).toBe(2)
    expect(recoverCalls).toBe(1)
  })

  test('does not retry when there is no recovery path', async () => {
    const { calls } = await run(() => new Response('', { status: 403 }))
    expect(calls).toBe(1)
  })

  test('does not retry when the refresh yields no new token', async () => {
    const { calls, recoverCalls } = await run(
      () => new Response('', { status: 403 }),
      async () => undefined
    )
    expect(calls).toBe(1)
    expect(recoverCalls).toBe(1)
  })

  test('leaves non-auth failures alone', async () => {
    const { calls, recoverCalls } = await run(
      () => new Response('', { status: 500 }),
      async () => ({ ...AUTH, access: 'fresh' })
    )
    expect(calls).toBe(1)
    expect(recoverCalls).toBe(0)
  })
})
