import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// Spread the real module so callers that need other exports (e.g. setup's
// setDebugEnabled) keep working. AGENTS.md: when overriding one export,
// spread the real module first.
const realLogger = await import('../plugin/logger.js')
mock.module('../plugin/logger.js', () => ({
  ...realLogger,
  debug: () => {},
  error: () => {},
  log: () => {},
  warn: () => {},
  getTimestamp: () => '2026-09-24T00:00:00.000Z',
  logApiError: () => {},
  logApiRequest: () => {},
  logApiResponse: () => {}
}))

const catalogModule = await import('../plugin/models.js')
const {
  getCatalogContextLimit,
  refreshModelCatalog,
  resetMemoryOnly,
  resetModelCatalog,
  subscribeCatalogUpdated
} = catalogModule

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

beforeEach(() => {
  resetMemoryOnly()
  resetModelCatalog()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  resetMemoryOnly()
  resetModelCatalog()
})

describe('subscribeCatalogUpdated', () => {
  test('fires when the catalog is populated by a live fetch', async () => {
    let receivedSize = -1
    const unsubscribe = subscribeCatalogUpdated((entries) => {
      receivedSize = entries.size
    })

    stubCatalog({
      models: [
        { modelId: 'claude-sonnet-4.5', tokenLimits: { maxInputTokens: 200000 } },
        { modelId: 'auto', tokenLimits: { maxInputTokens: 1000000 } }
      ]
    })
    await refreshModelCatalog(auth)

    expect(receivedSize).toBe(2)
    expect(getCatalogContextLimit('auto')).toBe(1000000)
    unsubscribe()
  })

  test('fires only when the in-memory catalog actually changes, not on resets', () => {
    let calls = 0
    const unsubscribe = subscribeCatalogUpdated(() => {
      calls++
    })

    // Resets null the in-memory map without populating it — no listener call.
    resetMemoryOnly()
    resetModelCatalog()
    expect(calls).toBe(0)

    unsubscribe()
  })

  test('the listener receives the new entries it will need to re-render', async () => {
    let lastEntries: ReadonlyMap<string, { maxInputTokens?: number }> | undefined
    const unsubscribe = subscribeCatalogUpdated((entries) => {
      lastEntries = entries as ReadonlyMap<string, { maxInputTokens?: number }>
    })

    stubCatalog({
      models: [{ modelId: 'auto', tokenLimits: { maxInputTokens: 1000000 } }]
    })
    await refreshModelCatalog(auth)

    expect(lastEntries).toBeDefined()
    expect(lastEntries!.size).toBe(1)
    expect(lastEntries!.get('auto')?.maxInputTokens).toBe(1000000)
    unsubscribe()
  })

  test('unsubscribe stops further notifications', async () => {
    let calls = 0
    const unsubscribe = subscribeCatalogUpdated(() => {
      calls++
    })

    stubCatalog({
      models: [{ modelId: 'claude-sonnet-4.5', tokenLimits: { maxInputTokens: 200000 } }]
    })
    await refreshModelCatalog(auth)
    expect(calls).toBe(1)

    unsubscribe()
    // Reset state and trigger another population to confirm silence.
    resetMemoryOnly()
    resetModelCatalog()
    await refreshModelCatalog(auth)
    expect(calls).toBe(1)
  })

  test('a listener that throws does not break the catalog pipeline', async () => {
    const unsubscribe = subscribeCatalogUpdated(() => {
      throw new Error('listener boom')
    })
    const safe: unknown[] = []
    subscribeCatalogUpdated((entries) => safe.push(entries.size))

    stubCatalog({
      models: [{ modelId: 'auto', tokenLimits: { maxInputTokens: 1000000 } }]
    })
    await expect(refreshModelCatalog(auth)).resolves.toBeUndefined()
    expect(getCatalogContextLimit('auto')).toBe(1000000)
    expect(safe).toEqual([1])

    unsubscribe()
  })
})
