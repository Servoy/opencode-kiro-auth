import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KiroDatabase } from '../plugin/storage/sqlite.js'
import type { ManagedAccount } from '../plugin/types.js'

function makeAccount(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: 'acc-1',
    email: 'test@example.com',
    authMethod: 'idc',
    region: 'eu-central-1',
    refreshToken: 'r',
    accessToken: 'a',
    expiresAt: Date.now() + 3600000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    lastUsed: 0,
    usedCount: 0,
    limitCount: 0,
    ...overrides
  }
}

let dir: string
let dbPath: string
let db: KiroDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kiro-test-'))
  dbPath = join(dir, 'test.db')
  db = new KiroDatabase(dbPath)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

// ── accounts CRUD ─────────────────────────────────────────────────────────────

describe('KiroDatabase: accounts', () => {
  test('starts empty', () => {
    expect(db.getAccounts()).toHaveLength(0)
  })

  test('upsertAccount stores and retrieves account', async () => {
    const acc = makeAccount()
    await db.upsertAccount(acc)
    const rows = db.getAccounts()
    expect(rows).toHaveLength(1)
    expect(rows[0].email).toBe('test@example.com')
    expect(rows[0].is_healthy).toBe(1)
  })

  test('upsertAccount updates token fields on existing account', async () => {
    const acc = makeAccount()
    await db.upsertAccount(acc)
    await db.upsertAccount({ ...acc, accessToken: 'new-token' })
    const rows = db.getAccounts()
    expect(rows).toHaveLength(1)
    expect(rows[0].access_token).toBe('new-token')
  })

  test('upsertAccount with permanent error sets isHealthy=false', async () => {
    const acc = makeAccount()
    await db.upsertAccount(acc)
    await db.upsertAccount({
      ...acc,
      isHealthy: false,
      unhealthyReason: 'ExpiredTokenException'
    })
    const rows = db.getAccounts()
    expect(rows).toHaveLength(1)
    expect(rows[0].is_healthy).toBe(0)
  })

  test('batchUpsertAccounts stores multiple accounts', async () => {
    const a = makeAccount({ id: 'a', email: 'a@example.com' })
    const b = makeAccount({ id: 'b', email: 'b@example.com' })
    await db.batchUpsertAccounts([a, b])
    expect(db.getAccounts()).toHaveLength(2)
  })

  test('deleteAccount removes account', async () => {
    const acc = makeAccount()
    await db.upsertAccount(acc)
    await db.deleteAccount('acc-1')
    expect(db.getAccounts()).toHaveLength(0)
  })

  test('deleteAccount on non-existent id is a no-op', async () => {
    await expect(db.deleteAccount('does-not-exist')).resolves.toBeUndefined()
  })
})

// ── reauth lock ───────────────────────────────────────────────────────────────

describe('KiroDatabase: reauth lock', () => {
  test('acquireReauthLock returns true when no lock held', () => {
    expect(db.acquireReauthLock()).toBe(true)
  })

  test('acquireReauthLock returns false when lock already held by this process', () => {
    db.acquireReauthLock()
    // Same process — process.kill(pid, 0) succeeds, so it's not dead
    expect(db.acquireReauthLock()).toBe(false)
  })

  test('isReauthLockHeld returns false when no lock', () => {
    expect(db.isReauthLockHeld()).toBe(false)
  })

  test('isReauthLockHeld returns true after acquire', () => {
    db.acquireReauthLock()
    expect(db.isReauthLockHeld()).toBe(true)
  })

  test('releaseReauthLock clears the lock', () => {
    db.acquireReauthLock()
    db.releaseReauthLock()
    expect(db.isReauthLockHeld()).toBe(false)
  })

  test('after release, lock can be acquired again', () => {
    db.acquireReauthLock()
    db.releaseReauthLock()
    expect(db.acquireReauthLock()).toBe(true)
  })

  test('stale lock (dead pid) is evicted on acquire', () => {
    // Insert a lock row with a pid that no process uses (high number)
    const { Database } = require('bun:sqlite')
    const rawDb = new Database(dbPath)
    rawDb.prepare('INSERT INTO reauth_lock (id, pid, acquired_at) VALUES (1, 9999999, ?)').run(
      Date.now() - 1000 // recent but dead pid
    )
    rawDb.close()
    // Re-open our db instance
    db.close()
    db = new KiroDatabase(dbPath)
    // Should evict dead-pid lock and acquire
    expect(db.acquireReauthLock()).toBe(true)
  })

  test('expired lock is evicted on acquire', () => {
    const { Database } = require('bun:sqlite')
    const rawDb = new Database(dbPath)
    rawDb.prepare('INSERT INTO reauth_lock (id, pid, acquired_at) VALUES (1, ?, ?)').run(
      process.pid,
      Date.now() - 200_000 // 200s ago, well past 120s TTL
    )
    rawDb.close()
    db.close()
    db = new KiroDatabase(dbPath)
    expect(db.acquireReauthLock()).toBe(true)
  })

  test('race-safe: row-replacement when prior dead-pid row exists', () => {
    // Simulate a row that the SELECT picked up as "expired" but is actually
    // the same one INSERT will try to write. INSERT OR REPLACE handles this.
    const { Database } = require('bun:sqlite')
    const rawDb = new Database(dbPath)
    rawDb
      .prepare('INSERT INTO reauth_lock (id, pid, acquired_at) VALUES (1, 9999998, ?)')
      .run(Date.now() - 200_000)
    rawDb.close()
    db.close()
    db = new KiroDatabase(dbPath)
    // Should not throw on PRIMARY KEY conflict
    expect(db.acquireReauthLock()).toBe(true)
    // The row now belongs to this process
    expect(db.isReauthLockHeld()).toBe(true)
  })
})

// ── usage sync lock ──────────────────────────────────────────────────────────

describe('KiroDatabase: usage sync lock', () => {
  test('acquireUsageSyncLock returns true when no lock held', () => {
    expect(db.acquireUsageSyncLock()).toBe(true)
  })

  test('acquireUsageSyncLock returns false when lock already held by this process', () => {
    db.acquireUsageSyncLock()
    expect(db.acquireUsageSyncLock()).toBe(false)
  })

  test('a usage lock does not block the reauth lock (separate purposes)', () => {
    db.acquireReauthLock()
    expect(db.acquireUsageSyncLock()).toBe(true)
  })

  test('a reauth lock does not block a usage lock', () => {
    db.acquireUsageSyncLock()
    expect(db.acquireReauthLock()).toBe(true)
  })

  test('isUsageSyncLockHeld returns false when no lock', () => {
    expect(db.isUsageSyncLockHeld()).toBe(false)
  })

  test('isUsageSyncLockHeld returns true after acquire', () => {
    db.acquireUsageSyncLock()
    expect(db.isUsageSyncLockHeld()).toBe(true)
  })

  test('releaseUsageSyncLock clears the lock', () => {
    db.acquireUsageSyncLock()
    db.releaseUsageSyncLock()
    expect(db.isUsageSyncLockHeld()).toBe(false)
  })

  test('after release the lock can be re-acquired', () => {
    db.acquireUsageSyncLock()
    db.releaseUsageSyncLock()
    expect(db.acquireUsageSyncLock()).toBe(true)
  })

  test('stale usage lock (dead pid) is evicted on acquire', () => {
    const { Database } = require('bun:sqlite')
    const rawDb = new Database(dbPath)
    rawDb
      .prepare(
        'INSERT OR REPLACE INTO reauth_lock (id, pid, acquired_at, purpose) VALUES (?, ?, ?, ?)'
      )
      .run(1, 9999999, Date.now() - 1000, 'usage_sync')
    rawDb.close()
    db.close()
    db = new KiroDatabase(dbPath)
    expect(db.acquireUsageSyncLock()).toBe(true)
  })

  test('expired usage lock is evicted on acquire', () => {
    const { Database } = require('bun:sqlite')
    const rawDb = new Database(dbPath)
    rawDb
      .prepare(
        'INSERT OR REPLACE INTO reauth_lock (id, pid, acquired_at, purpose) VALUES (?, ?, ?, ?)'
      )
      .run(1, process.pid, Date.now() - 400_000, 'usage_sync')
    rawDb.close()
    db.close()
    db = new KiroDatabase(dbPath)
    expect(db.acquireUsageSyncLock()).toBe(true)
  })

  test('releasing a usage lock does not release a reauth lock', () => {
    db.acquireReauthLock()
    db.acquireUsageSyncLock()
    db.releaseUsageSyncLock()
    expect(db.isReauthLockHeld()).toBe(true)
    expect(db.isUsageSyncLockHeld()).toBe(false)
  })
})

// ── conversations ─────────────────────────────────────────────────────────────

describe('KiroDatabase: conversations', () => {
  test('getConversationId returns undefined when not set', () => {
    expect(db.getConversationId('ws', 'fp')).toBeUndefined()
  })

  test('setConversationId and getConversationId round-trip', () => {
    db.setConversationId('ws', 'fp', 'conv-123', 'agent-123')
    expect(db.getConversationId('ws', 'fp')).toEqual({
      convId: 'conv-123',
      agentContinuationId: 'agent-123'
    })
  })

  test('setConversationId updates existing entry', () => {
    db.setConversationId('ws', 'fp', 'conv-1', 'agent-1')
    db.setConversationId('ws', 'fp', 'conv-2', 'agent-2')
    expect(db.getConversationId('ws', 'fp')).toEqual({
      convId: 'conv-2',
      agentContinuationId: 'agent-2'
    })
  })

  test('different fingerprints are independent', () => {
    db.setConversationId('ws', 'fp1', 'conv-A', 'agent-A')
    db.setConversationId('ws', 'fp2', 'conv-B', 'agent-B')
    expect(db.getConversationId('ws', 'fp1')).toEqual({
      convId: 'conv-A',
      agentContinuationId: 'agent-A'
    })
    expect(db.getConversationId('ws', 'fp2')).toEqual({
      convId: 'conv-B',
      agentContinuationId: 'agent-B'
    })
  })

  test('TTL cleanup removes old entries', () => {
    const { Database } = require('bun:sqlite')
    const rawDb = new Database(dbPath)
    rawDb
      .prepare(
        'INSERT INTO conversations (workspace, fingerprint, conv_id, agent_continuation_id, last_used) VALUES (?, ?, ?, ?, ?)'
      )
      .run('ws', 'old', 'conv-old', 'agent-old', Date.now() - 10 * 24 * 3600000) // 10 days old
    rawDb.close()
    db.close()
    db = new KiroDatabase(dbPath)
    // Trigger cleanup by setting a new one (ttlDays=7)
    db.setConversationId('ws', 'new', 'conv-new', 'agent-new', 7)
    expect(db.getConversationId('ws', 'old')).toBeUndefined()
    expect(db.getConversationId('ws', 'new')).toEqual({
      convId: 'conv-new',
      agentContinuationId: 'agent-new'
    })
  })

  test('deleteConversationId removes entry so next lookup returns undefined', () => {
    db.setConversationId('ws', 'fp', 'conv-del', 'agent-del')
    expect(db.getConversationId('ws', 'fp')).toBeDefined()
    db.deleteConversationId('ws', 'fp')
    expect(db.getConversationId('ws', 'fp')).toBeUndefined()
  })

  test('deleteConversationId is a no-op for non-existent entry', () => {
    expect(() => db.deleteConversationId('ws', 'missing')).not.toThrow()
  })
})

describe('KiroDatabase: session affinity', () => {
  test('remembers nothing for a session that has not been served', () => {
    expect(db.getSessionAccount('ses_unknown')).toBeUndefined()
  })

  test('gives back the account that served the session', () => {
    db.setSessionAccount('ses_a', 'acc-2')
    expect(db.getSessionAccount('ses_a')).toBe('acc-2')
  })

  test('re-pinning moves the session to the new account', () => {
    // The pin is advisory: when the pinned account is rate-limited the
    // selector falls through and the session follows whoever answered.
    db.setSessionAccount('ses_a', 'acc-2')
    db.setSessionAccount('ses_a', 'acc-3')
    expect(db.getSessionAccount('ses_a')).toBe('acc-3')
  })

  test('keeps sessions apart', () => {
    db.setSessionAccount('ses_a', 'acc-2')
    db.setSessionAccount('ses_b', 'acc-3')
    expect(db.getSessionAccount('ses_a')).toBe('acc-2')
    expect(db.getSessionAccount('ses_b')).toBe('acc-3')
  })

  test('forgets a pin older than its TTL', async () => {
    const ONE_MS_IN_DAYS = 1 / (24 * 60 * 60 * 1000)
    db.setSessionAccount('ses_old', 'acc-2')
    await new Promise((resolve) => setTimeout(resolve, 5))
    // Any write sweeps what fell outside the window.
    db.setSessionAccount('ses_new', 'acc-3', ONE_MS_IN_DAYS)

    expect(db.getSessionAccount('ses_old')).toBeUndefined()
    expect(db.getSessionAccount('ses_new')).toBe('acc-3')
  })
})

// ── session usage (panel cost estimate) ───────────────────────────────────────

describe('KiroDatabase: plugin_instances', () => {
  test('heartbeatInstance records this pid with version and source', () => {
    db.heartbeatInstance('2.2.0', '/path/to/dist/plugin/usage-snapshot.js')
    const rows = db.getPluginInstances()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.pid).toBe(process.pid)
    expect(rows[0]?.version).toBe('2.2.0')
    expect(rows[0]?.source).toBe('/path/to/dist/plugin/usage-snapshot.js')
  })

  test('heartbeatInstance upserts rather than duplicating the pid', () => {
    db.heartbeatInstance('2.2.0', '/a')
    db.heartbeatInstance('2.3.0', '/b')
    const rows = db.getPluginInstances()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.version).toBe('2.3.0')
    expect(rows[0]?.source).toBe('/b')
  })

  test('heartbeatInstance reaps rows whose process is dead', () => {
    // A pid that cannot exist (process.kill throws), inserted directly, is
    // swept on the next live heartbeat.
    const deadPid = 2147483000
    ;(db as any).db
      .prepare('INSERT INTO plugin_instances (pid, version, source, last_seen) VALUES (?, ?, ?, ?)')
      .run(deadPid, '2.1.3', '/old', Date.now())
    db.heartbeatInstance('2.2.0', '/new')
    const pids = db.getPluginInstances().map((r) => r.pid)
    expect(pids).toContain(process.pid)
    expect(pids).not.toContain(deadPid)
  })
})

describe('KiroDatabase: session_usage', () => {
  test('recordSessionRequest counts requests per (session, account)', () => {
    expect(db.recordSessionRequest('ses-1', 'acc-1')).toBe(1)
    expect(db.recordSessionRequest('ses-1', 'acc-1')).toBe(2)
    expect(db.recordSessionRequest('ses-2', 'acc-1')).toBe(1)
    expect(db.getSessionUsage('ses-1')?.requests).toBe(2)
    expect(db.getSessionUsage('ses-2')?.requests).toBe(1)
  })

  test('a session served by two accounts keeps counts separate but sums the total', () => {
    db.recordSessionRequest('ses-r', 'acc-1')
    db.recordSessionRequest('ses-r', 'acc-1')
    db.recordSessionRequest('ses-r', 'acc-2')
    const usage = db.getSessionUsage('ses-r')
    expect(usage?.requests).toBe(3)
    expect(usage?.accounts).toHaveLength(2)
    const byId = new Map(usage!.accounts.map((a) => [a.accountId, a.requests]))
    expect(byId.get('acc-1')).toBe(2)
    expect(byId.get('acc-2')).toBe(1)
  })

  test('apportionSessionCredits splits an account delta by request share within that account', () => {
    db.recordSessionRequest('ses-a', 'acc-1') // acc-1: 1 request
    db.recordSessionRequest('ses-b', 'acc-1')
    db.recordSessionRequest('ses-b', 'acc-1')
    db.recordSessionRequest('ses-b', 'acc-1') // acc-1: 3 requests
    // 4 total acc-1 requests, 40 credits → a gets 10, b gets 30.
    db.apportionSessionCredits('acc-1', 40, 0)
    expect(db.getSessionUsage('ses-a')?.estCredits).toBeCloseTo(10, 5)
    expect(db.getSessionUsage('ses-b')?.estCredits).toBeCloseTo(30, 5)
  })

  test('apportionSessionCredits only touches the given account, not others', () => {
    db.recordSessionRequest('ses-m', 'acc-1')
    db.recordSessionRequest('ses-m', 'acc-2')
    // acc-1's delta lands only on acc-1's share of ses-m.
    db.apportionSessionCredits('acc-1', 10, 0)
    const usage = db.getSessionUsage('ses-m')
    const byId = new Map(usage!.accounts.map((a) => [a.accountId, a.estCredits]))
    expect(byId.get('acc-1')).toBeCloseTo(10, 5)
    expect(byId.get('acc-2')).toBe(0)
    expect(usage?.estCredits).toBeCloseTo(10, 5)
  })

  test('apportionSessionCredits ignores rows used before the window', () => {
    db.recordSessionRequest('old', 'acc-1') // last_used ~ now
    const future = Date.now() + 60_000
    // Nothing was used at/after `future`, so no credits are apportioned.
    db.apportionSessionCredits('acc-1', 100, future)
    expect(db.getSessionUsage('old')?.estCredits).toBe(0)
  })

  test('apportionSessionCredits is a no-op for a zero or negative delta', () => {
    db.recordSessionRequest('ses-x', 'acc-1')
    db.apportionSessionCredits('acc-1', 0, 0)
    db.apportionSessionCredits('acc-1', -5, 0)
    expect(db.getSessionUsage('ses-x')?.estCredits).toBe(0)
  })

  test('getRecentSessionUsage returns newest first with metadata, one row per session', () => {
    db.recordSessionRequest('ses-old', 'acc-1', { title: 'Old', directory: '/a' })
    db.recordSessionRequest('ses-new', 'acc-1', { title: 'New', directory: '/b' })
    db.recordSessionRequest('ses-new', 'acc-2', { title: 'New', directory: '/b' })
    const recent = db.getRecentSessionUsage(10)
    expect(recent.filter((r) => r.sessionId === 'ses-new')).toHaveLength(1)
    expect(recent[0]?.sessionId).toBe('ses-new')
    expect(recent[0]?.title).toBe('New')
    expect(recent[0]?.directory).toBe('/b')
    expect(recent[0]?.accounts).toHaveLength(2)
  })
})
