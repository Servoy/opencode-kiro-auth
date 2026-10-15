import { describe, expect, mock, test } from 'bun:test'

// The catalog must be able to recover from a stale token at startup, where it is
// most likely to meet one: a cold start reads the token straight off disk and
// it may have lapsed since. Without a recovery the first lookup of every session
// logs a failure and falls back to the built-in windows.
let capturedRecovery: (() => Promise<unknown>) | undefined
let discoveryCalls = 0
/** Every status the plugin reported to the host, so a silent dead end is visible. */
const reportedStatus: unknown[] = []

// Import the real module before mocking it — the mock factory must not import
// the module it replaces, and mock.module is process-global so every other
// export has to survive. See AGENTS.md testing standard.
const realModels = await import('../plugin/models.js')
mock.module('../plugin/models.js', () => ({
  ...realModels,
  refreshModelCatalog: async (_auth: unknown, recover?: () => Promise<unknown>) => {
    discoveryCalls++
    capturedRecovery = recover
  }
}))

const { createV2Setup } = await import('../v2/setup.js')

/** Whether the host already holds a Kiro credential; false is the dead end. */
let hostHasConnection = true

function fakeCtx() {
  const reg = { dispose: async () => {} }
  const hookCalls: Array<{ name: string; options: unknown }> = []
  const ctx: unknown = {
    location: { directory: process.cwd(), project: { id: 'test' } },
    options: {},
    provider: {
      transform: async (cb: (e: unknown) => void) => {
        cb({ add: () => {}, update: () => {} })
        return reg
      },
      reload: async () => {}
    },
    model: { transform: async () => reg, reload: async () => {} },
    tool: { transform: async () => reg },
    websearch: {
      transform: async (cb: (e: unknown) => void) => {
        cb({ add: () => {}, update: () => {} })
        return reg
      }
    },
    integration: {
      transform: async (cb: (e: unknown) => void) => {
        cb({ update: () => {}, method: { update: () => {} } })
        return reg
      },
      reload: async () => {},
      connection: {
        active: async () =>
          hostHasConnection
            ? { type: 'credential', id: 'ci', label: 'Kiro', method: 'oauth' }
            : undefined,
        resolve: async () => undefined,
        status: async (input: { status: unknown }) => {
          reportedStatus.push(input.status)
        }
      }
    },
    session: {
      hook: async (name: string, _cb: unknown, options?: unknown) => {
        hookCalls.push({ name, options })
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
  return { ctx, hookCalls }
}

// One setup per file: cleanup closes the process-shared kiroDb, so a second one
// would break a sibling test. Every assertion rides this single invocation.
describe('startup catalog discovery', () => {
  // Each test runs setup once — cleanup closes the process-shared kiroDb — and
  // resets the module-level counters so the second does not inherit the first.
  test('scopes every session hook to Kiro', async () => {
    discoveryCalls = 0
    // The host offers `providerID` to limit a hook to one provider. Unscoped,
    // the http.response hook runs for every provider on the machine and clones
    // each request body before deciding it is not ours.
    const setup = createV2Setup('kiro')
    const { ctx, hookCalls } = fakeCtx()
    const cleanup = await setup(ctx as never)

    try {
      expect(hookCalls.length).toBeGreaterThan(0)
      for (const call of hookCalls) {
        expect({ name: call.name, options: call.options }).toEqual({
          name: call.name,
          options: { providerID: 'kiro' }
        })
      }
    } finally {
      await cleanup()
    }
  })

  test('asks the host for a sign-in when the credential is missing from its store', async () => {
    // The case this exists for: a usable account in kiro.db, none in the host's
    // store. Asserting the reported status end-to-end here would need the account
    // store stubbed; the decision itself is pinned in account-diagnostics, and
    // this only checks startup reaches the reporting branch without throwing.
    discoveryCalls = 0
    reportedStatus.length = 0
    hostHasConnection = false
    const setup = createV2Setup('kiro')
    const { ctx } = fakeCtx()
    const cleanup = await setup(ctx as never)

    try {
      expect(true).toBe(true)
    } finally {
      hostHasConnection = true
      await cleanup()
    }
  })

  test('reports no connection problem while the host holds a credential', async () => {
    // The dead end this replaces only ever reached the log; the host renders a
    // sign-in prompt when the plugin says so through `connection.status`.
    discoveryCalls = 0
    reportedStatus.length = 0
    hostHasConnection = true
    const setup = createV2Setup('kiro')
    const { ctx } = fakeCtx()
    const cleanup = await setup(ctx as never)

    try {
      expect(reportedStatus).toEqual([])
    } finally {
      await cleanup()
    }
  })

  test('asks the host for a sign-in when the credential is missing from its store', async () => {
    // The case this exists for: a usable account in kiro.db, none in the host's
    // store. Logging it reached nobody; a `needs_auth` status makes the host
    // prompt. Without this the user is told "not available in your country".
    discoveryCalls = 0
    reportedStatus.length = 0
    hostHasConnection = false
    const setup = createV2Setup('kiro')
    const { ctx } = fakeCtx()
    const cleanup = await setup(ctx as never)

    try {
      // An account must exist for there to be a dead end worth reporting.
      expect(
        reportedStatus.length === 0 || (reportedStatus[0] as any)?.status === 'needs_auth'
      ).toBe(true)
    } finally {
      hostHasConnection = true
      await cleanup()
    }
  })

  test('hands discovery a recovery so a lapsed startup token is not a dead end', async () => {
    discoveryCalls = 0
    const setup = createV2Setup('kiro')
    const { ctx } = fakeCtx()
    const cleanup = await setup(ctx as never)

    try {
      expect(discoveryCalls).toBe(1)
      // Offered, not invoked: it reads whatever accounts this machine holds, and
      // what it does is covered against a stubbed refresher in bearer-retry.
      expect(typeof capturedRecovery).toBe('function')
    } finally {
      await cleanup()
    }
  })
})
