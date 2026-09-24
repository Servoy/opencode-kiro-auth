import { describe, expect, test } from 'bun:test'
import { createV2Setup } from '../v2/setup.js'

function fakeCtx() {
  const record = {
    providerTransforms: 0,
    integrationTransforms: 0,
    hooks: [] as string[],
    providerAdded: null as { info: unknown; models: readonly unknown[] } | null
  }
  const reg = { dispose: async () => {} }
  const ctx: unknown = {
    location: { directory: process.cwd(), project: { id: 'test' } },
    options: {},
    provider: {
      transform: async (cb: (e: unknown) => void) => {
        record.providerTransforms++
        cb({
          add: (input: { info: unknown; models: readonly unknown[] }) => {
            record.providerAdded = input
          },
          update: () => {}
        })
        return reg
      },
      reload: async () => {}
    },
    model: { transform: async () => reg, reload: async () => {} },
    tool: { transform: async () => reg },
    integration: {
      transform: async (cb: (e: unknown) => void) => {
        record.integrationTransforms++
        cb({ update: () => {}, method: { update: () => {} } })
        return reg
      },
      reload: async () => {},
      connection: { active: async () => undefined, resolve: async () => undefined }
    },
    session: {
      hook: async (name: string) => {
        record.hooks.push(name)
        return reg
      }
    },
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          /* no events */
        }
      })
    }
  }
  return { ctx, record }
}

describe('createV2Setup', () => {
  // One setup invocation per describe: cleanup closes the process-shared
  // kiroDb, so running two setups and both cleanups in one process would break
  // a sibling test. All assertions ride the single invocation, cleanup last.
  test('wires provider, integration, both http hooks, model set, and cleanup', async () => {
    const setup = createV2Setup('kiro')
    const { ctx, record } = fakeCtx()
    const cleanup = await setup(ctx as never)

    expect(record.providerTransforms).toBeGreaterThanOrEqual(1)
    expect(record.integrationTransforms).toBeGreaterThanOrEqual(1)
    expect(record.hooks).toContain('http.request')
    expect(record.hooks).toContain('http.response')
    expect(record.providerAdded).not.toBeNull()
    expect(record.providerAdded!.models.length).toBeGreaterThan(0)
    expect(typeof cleanup).toBe('function')

    await (cleanup as () => Promise<void> | void)()
  })
})
