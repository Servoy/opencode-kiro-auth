import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ManagedAccount } from '../plugin/types.js'
import {
  _atomicReplaceForTest,
  buildAccountSnapshot,
  SNAPSHOT_SCHEMA,
  SNAPSHOT_SESSION_LIMIT,
  writeUsageSnapshot
} from '../plugin/usage-snapshot.js'
import type { UsageResult } from '../plugin/usage.js'

function makeAccount(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: 'acc-1',
    email: 'stored@example.com',
    authMethod: 'idc',
    region: 'eu-central-1',
    refreshToken: 'r',
    accessToken: 'a',
    expiresAt: 0,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 100,
    limitCount: 10000,
    ...overrides
  }
}

describe('buildAccountSnapshot', () => {
  test('maps the full getUsageLimits response into panel fields', () => {
    const usage: UsageResult = {
      usedCount: 4061.45,
      limitCount: 10000,
      email: 'real@example.com',
      subscriptionTitle: 'KIRO POWER',
      subscriptionType: 'Q_DEVELOPER_STANDALONE_POWER',
      overageStatus: 'DISABLED',
      overageRate: 0.04,
      overageCap: 10000,
      currentOverages: 0,
      unit: 'Credit',
      nextDateReset: 1790812800,
      daysUntilReset: 13
    }
    // 12 days and 23 hours before the reset: rounds up to 13 whole days.
    const now = 1790812800 * 1000 - (12 * 24 + 23) * 60 * 60 * 1000
    const snap = buildAccountSnapshot(makeAccount(), usage, now)

    expect(snap.used).toBe(4061.45)
    expect(snap.limit).toBe(10000)
    expect(snap.pct).toBe(41)
    expect(snap.plan).toBe('KIRO POWER')
    expect(snap.overageStatus).toBe('DISABLED')
    expect(snap.overageRate).toBe(0.04)
    expect(snap.overageCap).toBe(10000)
    // AWS reports reset in Unix seconds; the snapshot exposes ms.
    expect(snap.resetAt).toBe(1790812800 * 1000)
    expect(snap.daysUntilReset).toBe(13)
    expect(snap.email).toBe('real@example.com')
  })

  test('falls back to stored account values when no fresh usage is present', () => {
    const snap = buildAccountSnapshot(
      makeAccount({ usedCount: 250, limitCount: 1000 }),
      undefined,
      5
    )
    expect(snap.used).toBe(250)
    expect(snap.limit).toBe(1000)
    expect(snap.pct).toBe(25)
    expect(snap.plan).toBeUndefined()
    expect(snap.email).toBe('stored@example.com')
    expect(snap.updatedAt).toBe(5)
  })

  test('pct is 0 when no limit is known', () => {
    const snap = buildAccountSnapshot(makeAccount({ usedCount: 0, limitCount: 0 }), undefined, 0)
    expect(snap.pct).toBe(0)
  })

  test('without fresh usage, plan and reset come from the stored quota details', () => {
    const stored = {
      resetAt: 1790812800 * 1000,
      plan: 'KIRO POWER',
      planType: 'Q_DEVELOPER_STANDALONE_POWER',
      overageStatus: 'DISABLED',
      overageRate: 0.04,
      overageCap: 10000,
      currentOverages: 0,
      unit: 'Credit'
    }
    const snap = buildAccountSnapshot(makeAccount(), undefined, 1_000, stored)
    expect(snap.resetAt).toBe(stored.resetAt)
    expect(snap.plan).toBe('KIRO POWER')
    expect(snap.planType).toBe('Q_DEVELOPER_STANDALONE_POWER')
    expect(snap.overageStatus).toBe('DISABLED')
    expect(snap.overageRate).toBe(0.04)
    expect(snap.unit).toBe('Credit')
  })

  test('a fresh field wins over the stored one, and an omitted one falls back', () => {
    const fresh: UsageResult = { usedCount: 2, limitCount: 10, subscriptionTitle: 'KIRO PRO' }
    const snap = buildAccountSnapshot(makeAccount(), fresh, 1_000, {
      resetAt: 1790812800 * 1000,
      plan: 'KIRO POWER'
    })
    expect(snap.plan).toBe('KIRO PRO')
    expect(snap.resetAt).toBe(1790812800 * 1000)
  })

  test('daysUntilReset is derived from resetAt, not taken from Kiro', () => {
    const now = 1_800_000_000_000
    const resetAt = now + 12 * 24 * 60 * 60 * 1000 - 60_000
    const snap = buildAccountSnapshot(
      makeAccount(),
      { usedCount: 1, limitCount: 10, nextDateReset: resetAt / 1000, daysUntilReset: 0 },
      now
    )
    expect(snap.daysUntilReset).toBe(12)
  })

  test('resetAt is undefined when neither the sync nor the store has one', () => {
    const snap = buildAccountSnapshot(makeAccount(), { usedCount: 1, limitCount: 10 }, 1_000)
    expect(snap.resetAt).toBeUndefined()
    expect(snap.daysUntilReset).toBeUndefined()
  })
})

describe('writeUsageSnapshot insight fields', () => {
  // Real kiroDb under tmpdir (NODE_ENV=test routes it there). Seed session
  // activity, write the snapshot, read it back — proving the SMALL insight
  // fields reach the file the panel reads.
  test('writes schema, sessionsTotal and burn[].requests from real session usage', async () => {
    const { kiroDb } = await import('../plugin/storage/sqlite.js')
    const { getConfigDir } = await import('../plugin/config/paths.js')
    for (const row of kiroDb.getAccounts()) await kiroDb.deleteAccount(row.id)

    kiroDb.recordSessionRequest('s1', 'acc-1')
    kiroDb.recordSessionRequest('s1', 'acc-1') // same session, +1 request
    kiroDb.recordSessionRequest('s2', 'acc-1')

    const acc = makeAccount({ id: 'acc-1' })
    writeUsageSnapshot([acc], new Map())

    const file = JSON.parse(readFileSync(join(getConfigDir(), 'kiro-usage.json'), 'utf8')) as {
      schema?: number
      sessionsTotal?: number
      burn: Array<{ accountId: string; requests: number }>
    }
    expect(file.schema).toBe(SNAPSHOT_SCHEMA)
    expect(file.sessionsTotal).toBe(2)
    const burn = file.burn.find((b) => b.accountId === 'acc-1')
    expect(burn?.requests).toBe(3)
  })

  test('burn carries every request, metered credits only, and the counter delta', async () => {
    const { kiroDb } = await import('../plugin/storage/sqlite.js')
    const { getConfigDir } = await import('../plugin/config/paths.js')
    const now = Date.now()
    const meteredSince = kiroDb.getMeteredSince()!

    // A session begun before metering, and one after it: both count as
    // requests, only the later one as credits.
    kiroDb.recordSessionRequest('burn-new', 'acc-burn')
    kiroDb.addMeteredCredits('burn-new', 'acc-burn', 4)
    kiroDb.recordSessionRequest('burn-old', 'acc-burn')
    ;(kiroDb as any).db
      .prepare('UPDATE session_usage SET first_used = ?, est_credits = 99 WHERE session_id = ?')
      .run(meteredSince - 1, 'burn-old')

    kiroDb.recordUsageReading('acc-burn', 1000, now - 3 * 24 * 60 * 60 * 1000)
    kiroDb.recordUsageReading('acc-burn', 1012.5, now - 60_000)

    writeUsageSnapshot([makeAccount({ id: 'acc-burn' })], new Map())
    const file = JSON.parse(readFileSync(join(getConfigDir(), 'kiro-usage.json'), 'utf8'))
    const b = file.burn.find((x: any) => x.accountId === 'acc-burn')
    expect(b.requests).toBe(2)
    expect(b.credits).toBe(4)
    expect(b.counterDelta).toBeCloseTo(12.5, 10)
    expect(b.counterSince).toBe(now - 3 * 24 * 60 * 60 * 1000)
    expect(b.creditsSince).toBeGreaterThanOrEqual(meteredSince)
  })

  test('lists up to 50 sessions, not the old 20', async () => {
    const { kiroDb } = await import('../plugin/storage/sqlite.js')
    const { getConfigDir } = await import('../plugin/config/paths.js')
    for (let i = 0; i < 60; i++) kiroDb.recordSessionRequest(`cap-${i}`, 'acc-1')

    writeUsageSnapshot([makeAccount({ id: 'acc-1' })], new Map())

    const file = JSON.parse(readFileSync(join(getConfigDir(), 'kiro-usage.json'), 'utf8')) as {
      sessions: unknown[]
    }
    expect(file.sessions).toHaveLength(SNAPSHOT_SESSION_LIMIT)
    expect(SNAPSHOT_SESSION_LIMIT).toBe(50)
  })

  test('merges OpenCode tokens, tools and turns into listed sessions and adds window totals', async () => {
    const { kiroDb } = await import('../plugin/storage/sqlite.js')
    const { getConfigDir } = await import('../plugin/config/paths.js')
    const { resetOpenCodeInsightsForTest } = await import('../plugin/opencode-insights.js')
    const { openDatabase } = await import('../plugin/storage/database-driver.js')

    // An OpenCode-shaped fixture db: one root session with one subagent child.
    const dir = mkdtempSync(join(tmpdir(), 'kiro-ocdb-'))
    const dbPath = join(dir, 'opencode.db')
    const oc = openDatabase(dbPath)
    oc.exec(
      'CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, time_updated INTEGER NOT NULL)'
    )
    oc.exec(
      'CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)'
    )
    const now = Date.now()
    oc.prepare('INSERT INTO session_v2 VALUES (?, ?, ?)').run('merge-root', null, now)
    oc.prepare('INSERT INTO session_v2 VALUES (?, ?, ?)').run('merge-child', 'merge-root', now)
    const msg = (id: string, sid: string, finish: string, input: number, tools: string[]) =>
      oc.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)').run(
        id,
        sid,
        'assistant',
        now,
        JSON.stringify({
          model: { providerID: 'kiro' },
          finish,
          tokens: { input, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          content: tools.map((name) => ({ type: 'tool', name }))
        })
      )
    msg('a', 'merge-root', 'tool-calls', 100, ['read'])
    msg('b', 'merge-child', 'stop', 50, ['shell', 'read'])

    process.env.OPENCODE_DB = dbPath
    resetOpenCodeInsightsForTest()
    try {
      kiroDb.recordSessionRequest('merge-root', 'acc-1')
      const acc = makeAccount({ id: 'acc-1' })
      // First write renders without insights and starts the background read;
      // the read's own rewrite lands the insights.
      writeUsageSnapshot([acc], new Map())
      const path = join(getConfigDir(), 'kiro-usage.json')
      let file: any
      for (let i = 0; i < 50; i++) {
        file = JSON.parse(readFileSync(path, 'utf8'))
        if (file.tools) break
        await new Promise((r) => setTimeout(r, 20))
      }

      const s = file.sessions.find((x: any) => x.sessionId === 'merge-root')
      expect(s.tokens).toEqual({
        uncachedInputTokens: 150,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reportedRequests: 2
      })
      expect(s.turns).toEqual({ toolUse: 1, answer: 1, error: 0 })
      expect(s.toolCalls).toBe(3)
      expect(s.tools).toEqual([
        { name: 'read', count: 2 },
        { name: 'shell', count: 1 }
      ])
      expect(file.tools).toEqual({
        windowDays: 7,
        totalCalls: 3,
        items: [
          { name: 'read', count: 2 },
          { name: 'shell', count: 1 }
        ]
      })
      expect(file.tokens.windowDays).toBe(7)
      expect(file.tokens.reportedRequests).toBe(2)
    } finally {
      delete process.env.OPENCODE_DB
      resetOpenCodeInsightsForTest()
      oc.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('omits the insight fields when OpenCode cannot be read, so the panel shows not reported', async () => {
    const { kiroDb } = await import('../plugin/storage/sqlite.js')
    const { getConfigDir } = await import('../plugin/config/paths.js')
    const { resetOpenCodeInsightsForTest } = await import('../plugin/opencode-insights.js')
    resetOpenCodeInsightsForTest()
    kiroDb.recordSessionRequest('no-oc', 'acc-1')

    writeUsageSnapshot([makeAccount({ id: 'acc-1' })], new Map())

    const file = JSON.parse(readFileSync(join(getConfigDir(), 'kiro-usage.json'), 'utf8'))
    expect(file.tools).toBeUndefined()
    expect(file.tokens).toBeUndefined()
    const s = file.sessions.find((x: any) => x.sessionId === 'no-oc')
    expect(s.tokens).toBeUndefined()
    expect(s.tools).toBeUndefined()
  })
})

describe('atomicReplace (Windows-safe snapshot swap)', () => {
  test('replaces an existing target with the temp file contents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiro-atomic-'))
    try {
      const target = join(dir, 'snap.json')
      const tmp = `${target}.tmp`
      writeFileSync(target, 'OLD')
      writeFileSync(tmp, 'NEW')
      _atomicReplaceForTest(tmp, target)
      expect(readFileSync(target, 'utf8')).toBe('NEW')
      // The temp file must not linger after a successful swap.
      expect(existsSync(tmp)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('on Windows-style EPERM, it removes the target then retries the rename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiro-atomic-'))
    try {
      const target = join(dir, 'snap.json')
      const tmp = `${target}.tmp`
      writeFileSync(target, 'OLD')
      writeFileSync(tmp, 'NEW')
      // Simulate Windows: the first rename onto an existing target throws
      // EPERM; only after the target is removed does the rename succeed.
      let targetPresent = true
      let renameCalls = 0
      const fakeFs = {
        rename: (from: string, to: string) => {
          renameCalls++
          if (targetPresent) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
          renameSync(from, to)
        },
        remove: (p: string) => {
          if (p === target) targetPresent = false
          rmSync(p, { force: true })
        }
      }
      _atomicReplaceForTest(tmp, target, fakeFs)
      expect(renameCalls).toBe(2)
      expect(readFileSync(target, 'utf8')).toBe('NEW')
      expect(existsSync(tmp)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('when both renames fail, the temp file is cleaned up and the error rethrows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiro-atomic-'))
    try {
      const target = join(dir, 'snap.json')
      const tmp = `${target}.tmp`
      writeFileSync(tmp, 'NEW')
      const removed: string[] = []
      const fakeFs = {
        rename: () => {
          throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
        },
        remove: (p: string) => {
          removed.push(p)
          rmSync(p, { force: true })
        }
      }
      expect(() => _atomicReplaceForTest(tmp, target, fakeFs)).toThrow(/EBUSY/)
      // The temp file must be cleaned up so it does not accumulate.
      expect(removed).toContain(tmp)
      expect(existsSync(tmp)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
