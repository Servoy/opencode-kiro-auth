import { afterAll, describe, expect, mock, test } from 'bun:test'

// A real UsageTracker sync against the real kiroDb, with only the network
// stubbed: proves each sync records a counter reading, which is where
// burn[].counterDelta comes from. Without this wiring the column stays empty.

mock.module('../plugin/logger.js', () => ({
  debug: () => {},
  error: () => {},
  log: () => {},
  warn: () => {},
  setDebugEnabled: () => {},
  getTimestamp: () => '2026-11-19T00:00:00.000Z',
  logApiError: () => {},
  logApiRequest: () => {},
  logApiResponse: () => {}
}))

let used = 100
const originalFetch = globalThis.fetch
globalThis.fetch = (async () =>
  new Response(
    JSON.stringify({
      usageBreakdownList: [
        {
          currentUsage: used,
          currentUsageWithPrecision: used,
          usageLimit: 10000,
          usageLimitWithPrecision: 10000,
          resourceType: 'CREDIT',
          displayName: 'Credit',
          nextDateReset: 1796083200
        }
      ],
      subscriptionInfo: { subscriptionTitle: 'KIRO POWER', type: 'Q_DEVELOPER_STANDALONE_POWER' },
      overageConfiguration: { overageStatus: 'DISABLED' },
      userInfo: { email: 'reader@example.com' }
    }),
    { status: 200 }
  )) as unknown as typeof fetch

afterAll(() => {
  globalThis.fetch = originalFetch
})

const { UsageTracker } = await import('../core/account/usage-tracker.js')
const { kiroDb } = await import('../plugin/storage/sqlite.js')

describe('UsageTracker records counter readings', () => {
  test('each sync stores the counter, and two syncs yield the delta between them', async () => {
    const account: any = {
      id: 'acc-readings',
      email: 'reader@example.com',
      authMethod: 'idc',
      region: 'us-east-1',
      refreshToken: 'r',
      accessToken: 'a',
      expiresAt: Date.now() + 60_000,
      isHealthy: true,
      failCount: 0,
      usedCount: 0,
      limitCount: 0
    }
    const accountManager: any = { getAccounts: () => [account], updateUsage: () => {} }
    const repository: any = { invalidateCache: () => {} }
    const tracker = new UsageTracker(
      { usage_tracking_enabled: true, usage_sync_max_retries: 0 },
      accountManager,
      repository
    )
    const auth: any = {
      access: 'a',
      refresh: 'r',
      expires: 0,
      authMethod: 'idc',
      region: 'us-east-1'
    }

    used = 100
    await tracker.syncNow(account, auth)
    // A sync takes well over a millisecond in production; here it may not.
    await new Promise((r) => setTimeout(r, 5))
    used = 112.25
    await tracker.syncNow(account, auth)

    // Readings are keyed by the millisecond they were taken, so two syncs in
    // the same millisecond would collide into one reading. Look a moment ahead
    // so the window covers both however fast the second sync ran.
    const delta = kiroDb
      .getCounterDeltas(7 * 24 * 60 * 60 * 1000, Date.now() + 1000)
      .get('acc-readings')
    expect(delta?.delta).toBeCloseTo(12.25, 10)
  })
})

describe('quota details survive a restart', () => {
  test('a fresh instance that has not synced writes the same resetAt as before the restart', async () => {
    const { writeUsageSnapshot } = await import('../plugin/usage-snapshot.js')
    const { getConfigDir } = await import('../plugin/config/paths.js')
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const snapshot = () =>
      JSON.parse(readFileSync(join(getConfigDir(), 'kiro-usage.json'), 'utf8')).accounts.find(
        (a: any) => a.id === 'acc-restart'
      )

    // Instance A syncs: getUsageLimits carries the reset date and the plan.
    const synced: any = {
      id: 'acc-restart',
      email: 'restart@example.com',
      authMethod: 'idc',
      region: 'us-east-1',
      refreshToken: 'r',
      accessToken: 'a',
      expiresAt: Date.now() + 60_000,
      isHealthy: true,
      failCount: 0,
      usedCount: 0,
      limitCount: 0
    }
    const tracker = new UsageTracker(
      { usage_tracking_enabled: true, usage_sync_max_retries: 0 },
      { getAccounts: () => [synced], updateUsage: () => {} } as any,
      { invalidateCache: () => {} } as any
    )
    used = 300
    await tracker.syncNow(synced, {
      access: 'a',
      refresh: 'r',
      expires: 0,
      authMethod: 'idc',
      region: 'us-east-1'
    } as any)
    const before = snapshot()
    expect(before.resetAt).toBe(1796083200000)
    expect(before.plan).toBe('KIRO POWER')

    // Instance B starts fresh: the account comes from disk, it has not synced,
    // and it writes the snapshot at startup with no fresh usage.
    const fromDisk: any = { ...synced }
    writeUsageSnapshot([fromDisk], new Map())
    const after = snapshot()
    expect(after.resetAt).toBe(before.resetAt)
    expect(after.plan).toBe(before.plan)
    expect(after.overageStatus).toBe(before.overageStatus)
  })
})
