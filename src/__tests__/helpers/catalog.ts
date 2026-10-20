import { refreshModelCatalog, resetModelCatalog } from '../../plugin/models.js'

/** Loads a catalog for one test and puts the global state back afterwards. */
export async function withCatalog(
  entries: unknown[],
  run: () => void | Promise<void>
): Promise<void> {
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
    await run()
  } finally {
    globalThis.fetch = original
    resetModelCatalog()
  }
}
