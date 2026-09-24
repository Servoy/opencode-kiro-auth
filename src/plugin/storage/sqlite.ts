import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from '../config/paths'
import type { ManagedAccount } from '../types'
import { openDatabase, type SqliteDatabase } from './database-driver'
import { deduplicateAccounts, mergeAccounts, withDatabaseLock } from './locked-operations'
import { runMigrations } from './migrations'

const DB_PATH = join(getConfigDir(), 'kiro.db')

/** One account's share of a session: what it served and what it is estimated to have cost. */
export interface SessionAccountUsage {
  accountId: string
  requests: number
  estCredits: number
  firstUsed: number
  lastUsed: number
}

/**
 * A session's usage summed across every account that served it, with the
 * per-account breakdown kept so the panel can show who spent what.
 */
export interface SessionUsageRow {
  sessionId: string
  title?: string
  directory?: string
  requests: number
  estCredits: number
  firstUsed: number
  lastUsed: number
  accounts: SessionAccountUsage[]
}

/** Roll per-(session, account) rows up into one session total plus its breakdown. */
function aggregateSessionRows(
  sessionId: string,
  title: string | undefined,
  directory: string | undefined,
  rows: Array<{
    account_id: string
    requests: number
    est_credits: number
    first_used: number
    last_used: number
  }>
): SessionUsageRow {
  const accounts = rows
    .map((r) => ({
      accountId: r.account_id,
      requests: r.requests,
      estCredits: r.est_credits,
      firstUsed: r.first_used,
      lastUsed: r.last_used
    }))
    .sort((a, b) => b.lastUsed - a.lastUsed)
  return {
    sessionId,
    title,
    directory,
    requests: accounts.reduce((n, a) => n + a.requests, 0),
    estCredits: accounts.reduce((n, a) => n + a.estCredits, 0),
    firstUsed: Math.min(...accounts.map((a) => a.firstUsed)),
    lastUsed: Math.max(...accounts.map((a) => a.lastUsed)),
    accounts
  }
}

export class KiroDatabase {
  private db: SqliteDatabase
  private path: string

  constructor(path: string = DB_PATH) {
    this.path = path
    const dir = join(path, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.db = openDatabase(path)
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.init()
  }
  private init() {
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, auth_method TEXT NOT NULL,
        region TEXT NOT NULL, oidc_region TEXT, client_id TEXT, client_secret TEXT, profile_arn TEXT,
        start_url TEXT,
        refresh_token TEXT NOT NULL, access_token TEXT NOT NULL, expires_at INTEGER NOT NULL,
        rate_limit_reset INTEGER DEFAULT 0, is_healthy INTEGER DEFAULT 1, unhealthy_reason TEXT,
        recovery_time INTEGER, fail_count INTEGER DEFAULT 0, last_used INTEGER DEFAULT 0,
        used_count INTEGER DEFAULT 0, limit_count INTEGER DEFAULT 0, last_sync INTEGER DEFAULT 0
      )
    `)
    runMigrations(this.db)
  }

  getAccounts(): any[] {
    return this.db.prepare('SELECT * FROM accounts').all()
  }

  private upsertAccountInternal(acc: any) {
    this.db
      .prepare(
        `
      INSERT INTO accounts (
        id, email, auth_method, region, oidc_region, client_id, client_secret,
        profile_arn, start_url, refresh_token, access_token, expires_at, rate_limit_reset,
        is_healthy, unhealthy_reason, recovery_time, fail_count, last_used,
        used_count, limit_count, last_sync
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        id=excluded.id, email=excluded.email, auth_method=excluded.auth_method,
        region=excluded.region, oidc_region=excluded.oidc_region, client_id=excluded.client_id, client_secret=excluded.client_secret,
        profile_arn=excluded.profile_arn, start_url=excluded.start_url, refresh_token=excluded.refresh_token,
        access_token=excluded.access_token, expires_at=excluded.expires_at,
        rate_limit_reset=excluded.rate_limit_reset, is_healthy=excluded.is_healthy,
        unhealthy_reason=excluded.unhealthy_reason, recovery_time=excluded.recovery_time,
        fail_count=excluded.fail_count, last_used=excluded.last_used,
        used_count=excluded.used_count, limit_count=excluded.limit_count, last_sync=excluded.last_sync
    `
      )
      .run(
        acc.id,
        acc.email,
        acc.authMethod,
        acc.region,
        acc.oidcRegion || null,
        acc.clientId || null,
        acc.clientSecret || null,
        acc.profileArn || null,
        acc.startUrl || null,
        acc.refreshToken,
        acc.accessToken,
        acc.expiresAt,
        acc.rateLimitResetTime || 0,
        acc.isHealthy ? 1 : 0,
        acc.unhealthyReason || null,
        acc.recoveryTime || null,
        acc.failCount || 0,
        acc.lastUsed || 0,
        acc.usedCount || 0,
        acc.limitCount || 0,
        acc.lastSync || 0
      )
  }

  async upsertAccount(acc: ManagedAccount): Promise<void> {
    await withDatabaseLock(this.path, async () => {
      const existing = this.getAccounts().map(this.rowToAccount)
      const merged = mergeAccounts(existing, [acc])
      const deduplicated = deduplicateAccounts(merged)

      this.db.exec('BEGIN TRANSACTION')
      try {
        for (const account of deduplicated) {
          this.upsertAccountInternal(account)
        }
        this.db.exec('COMMIT')
      } catch (e) {
        this.db.exec('ROLLBACK')
        throw e
      }
    })
  }

  async batchUpsertAccounts(accounts: ManagedAccount[]): Promise<void> {
    await withDatabaseLock(this.path, async () => {
      const existing = this.getAccounts().map(this.rowToAccount)
      const merged = mergeAccounts(existing, accounts)
      const deduplicated = deduplicateAccounts(merged)

      this.db.exec('BEGIN TRANSACTION')
      try {
        for (const account of deduplicated) {
          this.upsertAccountInternal(account)
        }
        this.db.exec('COMMIT')
      } catch (e) {
        this.db.exec('ROLLBACK')
        throw e
      }
    })
  }

  async deleteAccount(id: string): Promise<void> {
    await withDatabaseLock(this.path, async () => {
      this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
    })
  }

  async markAccountsUnhealthy(ids: string[], reason: string): Promise<void> {
    if (ids.length === 0) return

    await withDatabaseLock(this.path, async () => {
      const now = Date.now()

      this.db.exec('BEGIN TRANSACTION')
      try {
        const stmt = this.db.prepare(
          `
            UPDATE accounts
            SET is_healthy = 0,
                unhealthy_reason = ?,
                recovery_time = NULL,
                fail_count = 10,
                rate_limit_reset = 0,
                last_sync = ?
            WHERE id = ?
          `
        )

        for (const id of ids) {
          stmt.run(reason, now, id)
        }

        this.db.exec('COMMIT')
      } catch (e) {
        this.db.exec('ROLLBACK')
        throw e
      }
    })
  }

  async cleanupTestAndStaleAccounts(staleDays = 30): Promise<number> {
    const cutoffMs = Date.now() - staleDays * 24 * 60 * 60 * 1000
    return withDatabaseLock(this.path, async () => {
      const before = (this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number })
        .n
      this.db
        .prepare(
          `DELETE FROM accounts
           WHERE email = 'test@example.com'
              OR email LIKE 'placeholder-%@awsapps.local'
              OR (auth_method = 'idc' AND (profile_arn IS NULL OR profile_arn = ''))
              OR (is_healthy = 0
                  AND unhealthy_reason IN ('Account Suspended', 'ExpiredTokenException')
                  AND (recovery_time IS NULL OR recovery_time < ?))`
        )
        .run(cutoffMs)
      const after = (this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n
      return before - after
    })
  }

  async deleteStaleIdcDuplicates(
    canonicalId: string,
    email: string,
    profileArn: string
  ): Promise<void> {
    await withDatabaseLock(this.path, async () => {
      this.db
        .prepare(
          `DELETE FROM accounts
           WHERE auth_method = 'idc'
             AND email = ?
             AND profile_arn = ?
             AND id != ?`
        )
        .run(email, profileArn, canonicalId)
      // Also clean up placeholder rows for the same profileArn.
      this.db
        .prepare(
          `DELETE FROM accounts
           WHERE auth_method = 'idc'
             AND profile_arn = ?
             AND email LIKE 'placeholder-%'
             AND id != ?`
        )
        .run(profileArn, canonicalId)
    })
  }

  private rowToAccount(row: any): ManagedAccount {
    return {
      id: row.id,
      email: row.email,
      authMethod: row.auth_method,
      region: row.region,
      oidcRegion: row.oidc_region || undefined,
      clientId: row.client_id,
      clientSecret: row.client_secret,
      profileArn: row.profile_arn,
      startUrl: row.start_url || undefined,
      refreshToken: row.refresh_token,
      accessToken: row.access_token,
      expiresAt: row.expires_at,
      rateLimitResetTime: row.rate_limit_reset,
      isHealthy: row.is_healthy === 1,
      unhealthyReason: row.unhealthy_reason,
      recoveryTime: row.recovery_time,
      failCount: row.fail_count,
      lastUsed: row.last_used,
      usedCount: row.used_count,
      limitCount: row.limit_count,
      lastSync: row.last_sync
    }
  }

  private static readonly REAUTH_LOCK_TTL_MS = 120_000
  private static readonly USAGE_SYNC_LOCK_TTL_MS = 300_000

  /**
   * Cross-instance advisory locks, keyed on (id, purpose). One row per
   * purpose — reauth and usage_sync coexist on the same id without
   * blocking each other. Uses the same TTL + dead-pid eviction pattern:
   * a lock is held when (now - acquired_at < ttl) AND (process.kill(pid, 0)
   * succeeds); otherwise the row is reaped.
   */
  private acquireLock(purpose: string, ttlMs: number): boolean {
    const now = Date.now()
    try {
      this.db.exec('BEGIN IMMEDIATE')
    } catch {
      return false
    }
    try {
      const existing = this.db
        .prepare('SELECT pid, acquired_at FROM reauth_lock WHERE id = 1 AND purpose = ?')
        .get(purpose) as { pid: number; acquired_at: number } | undefined

      if (existing) {
        const expired = now - existing.acquired_at >= ttlMs
        const dead = (() => {
          try {
            process.kill(existing.pid, 0)
            return false
          } catch {
            return true
          }
        })()
        if (expired || dead) {
          this.db.prepare('DELETE FROM reauth_lock WHERE id = 1 AND purpose = ?').run(purpose)
        } else {
          this.db.exec('ROLLBACK')
          return false
        }
      }

      this.db
        .prepare(
          'INSERT OR REPLACE INTO reauth_lock (id, purpose, pid, acquired_at) VALUES (1, ?, ?, ?)'
        )
        .run(purpose, process.pid, now)
      this.db.exec('COMMIT')
      return true
    } catch {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // already rolled back
      }
      return false
    }
  }

  private isLockHeld(purpose: string): boolean {
    const row = this.db
      .prepare('SELECT pid FROM reauth_lock WHERE id = 1 AND purpose = ?')
      .get(purpose) as { pid: number } | undefined
    if (!row) return false
    try {
      process.kill(row.pid, 0)
      return true
    } catch {
      return false
    }
  }

  acquireReauthLock(): boolean {
    return this.acquireLock('reauth', KiroDatabase.REAUTH_LOCK_TTL_MS)
  }

  isReauthLockHeld(): boolean {
    return this.isLockHeld('reauth')
  }

  releaseReauthLock(): void {
    this.db
      .prepare('DELETE FROM reauth_lock WHERE id = 1 AND purpose = ? AND pid = ?')
      .run('reauth', process.pid)
  }

  /**
   * Cross-instance advisory lock for the startup usage-sync fetch.
   *
   * Each OpenChamber project loads its own plugin instance; without this
   * lock, 15+ instances on one machine would each fire a usage fetch on
   * startup, Kiro would rate-limit the majority, and the log would fill
   * with "Startup usage fetch failed" warnings. The lock plus a TTL window
   * collapses that to one fetch per account per TTL — non-holders read the
   * already-stored usage value and skip silently.
   */
  acquireUsageSyncLock(): boolean {
    return this.acquireLock('usage_sync', KiroDatabase.USAGE_SYNC_LOCK_TTL_MS)
  }

  isUsageSyncLockHeld(): boolean {
    return this.isLockHeld('usage_sync')
  }

  releaseUsageSyncLock(): void {
    this.db
      .prepare('DELETE FROM reauth_lock WHERE id = 1 AND purpose = ? AND pid = ?')
      .run('usage_sync', process.pid)
  }

  /**
   * Does not close the connection: kiroDb is shared machine-wide, so under WAL
   * the OS reclaims it at process exit. Releases only the reauth mutex; the
   * usage_sync gate stays held so a reload does not re-storm Kiro.
   */
  close(): void {
    try {
      this.releaseReauthLock()
    } catch {
      // best effort — cleanup must not throw during dispose
    }
  }

  getConversationId(
    workspace: string,
    fingerprint: string
  ): { convId: string; agentContinuationId: string } | undefined {
    const row = this.db
      .prepare(
        'SELECT conv_id, agent_continuation_id FROM conversations WHERE workspace = ? AND fingerprint = ?'
      )
      .get(workspace, fingerprint) as
      | { conv_id: string; agent_continuation_id: string | null }
      | undefined
    return row
      ? { convId: row.conv_id, agentContinuationId: row.agent_continuation_id || '' }
      : undefined
  }

  /** The account that served this session, if one is still remembered. */
  getSessionAccount(sessionId: string): string | undefined {
    const row = this.db
      .prepare('SELECT account_id FROM session_accounts WHERE session_id = ?')
      .get(sessionId) as { account_id: string } | undefined
    return row?.account_id
  }

  /**
   * Remember which account served a session, dropping entries past ttlDays.
   *
   * The conversation rows they pair with expire on the same schedule, so a
   * session that outlives its conversationId is not held to a stale account.
   */
  setSessionAccount(sessionId: string, accountId: string, ttlDays = 7): void {
    const now = Date.now()
    const cutoff = now - ttlDays * 24 * 60 * 60 * 1000
    this.db.exec('BEGIN TRANSACTION')
    try {
      this.db
        .prepare(
          `INSERT INTO session_accounts (session_id, account_id, last_used)
           VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET account_id = excluded.account_id, last_used = excluded.last_used`
        )
        .run(sessionId, accountId, now)
      this.db.prepare('DELETE FROM session_accounts WHERE last_used < ?').run(cutoff)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /** The stored catalog for an account, whether or not it is still fresh. */
  getModelCatalog(
    key: string
  ): { models: Record<string, unknown>; attemptedAt: number; ttlMs: number } | undefined {
    const row = this.db
      .prepare('SELECT models, attempted_at, ttl_ms FROM model_catalog WHERE key = ?')
      .get(key) as { models: string; attempted_at: number; ttl_ms: number } | undefined
    if (!row) return undefined
    try {
      return {
        models: JSON.parse(row.models),
        attemptedAt: row.attempted_at,
        ttlMs: row.ttl_ms
      }
    } catch {
      return undefined
    }
  }

  /** Record a catalog lookup so other projects reuse it instead of repeating it. */
  setModelCatalog(
    key: string,
    models: Record<string, unknown>,
    attemptedAt: number,
    ttlMs: number
  ): void {
    this.db
      .prepare(
        `INSERT INTO model_catalog (key, models, attempted_at, ttl_ms) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           models = excluded.models,
           attempted_at = excluded.attempted_at,
           ttl_ms = excluded.ttl_ms`
      )
      .run(key, JSON.stringify(models), attemptedAt, ttlMs)
  }

  /** Test-only: forget the stored catalog so the next lookup refetches. */
  deleteModelCatalog(): void {
    this.db.prepare('DELETE FROM model_catalog').run()
  }

  /**
   * Record one Kiro request for a (session, account) pair and return that
   * pair's running request count.
   *
   * The count is the raw unit Kiro bills on (one invocation), incremented on
   * every served request. `accountId` is the account that actually served it,
   * so credits can later be apportioned per account — a session that rotates
   * across accounts keeps each account's share separate. Credit apportioning
   * happens in `apportionSessionCredits`. Rows expire past ttlDays so the table
   * tracks recent work, not all history.
   */
  recordSessionRequest(
    sessionId: string,
    accountId: string,
    meta: { title?: string; directory?: string } = {},
    ttlDays = 7
  ): number {
    const now = Date.now()
    const cutoff = now - ttlDays * 24 * 60 * 60 * 1000
    this.db.exec('BEGIN TRANSACTION')
    try {
      this.db
        .prepare(
          `INSERT INTO session_usage (session_id, account_id, title, directory, requests, est_credits, first_used, last_used)
           VALUES (?, ?, ?, ?, 1, 0, ?, ?)
           ON CONFLICT(session_id, account_id) DO UPDATE SET
             requests = requests + 1,
             last_used = excluded.last_used,
             title = COALESCE(excluded.title, session_usage.title),
             directory = COALESCE(excluded.directory, session_usage.directory)`
        )
        .run(sessionId, accountId, meta.title ?? null, meta.directory ?? null, now, now)
      this.db.prepare('DELETE FROM session_usage WHERE last_used < ?').run(cutoff)
      const row = this.db
        .prepare('SELECT requests FROM session_usage WHERE session_id = ? AND account_id = ?')
        .get(sessionId, accountId) as { requests: number } | undefined
      this.db.exec('COMMIT')
      return row?.requests ?? 1
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * Spread one account's credit delta across the (session, account) rows that
   * ran on *that account* since the last apportioning, weighted by each row's
   * request share.
   *
   * `deltaCredits` is (new account total − previous total) from a usage sync,
   * so it belongs only to work served by `accountId`; rows for other accounts
   * are untouched. Only rows used at/after `sinceMs` share it, so credits land
   * on the work that produced them. This is an estimate: a cheap and an
   * expensive request both count as one, and a shared account can mix in a
   * colleague's usage. The panel labels it as such.
   */
  apportionSessionCredits(accountId: string, deltaCredits: number, sinceMs: number): void {
    if (!(deltaCredits > 0)) return
    const rows = this.db
      .prepare(
        'SELECT session_id, requests FROM session_usage WHERE account_id = ? AND last_used >= ? AND requests > 0'
      )
      .all(accountId, sinceMs) as Array<{ session_id: string; requests: number }>
    const totalRequests = rows.reduce((n, r) => n + r.requests, 0)
    if (totalRequests <= 0) return
    this.db.exec('BEGIN TRANSACTION')
    try {
      const stmt = this.db.prepare(
        'UPDATE session_usage SET est_credits = est_credits + ? WHERE session_id = ? AND account_id = ?'
      )
      for (const r of rows) {
        stmt.run((deltaCredits * r.requests) / totalRequests, r.session_id, accountId)
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * One session's usage summed across every account that served it, plus the
   * per-account breakdown behind the totals.
   */
  getSessionUsage(sessionId: string): SessionUsageRow | undefined {
    const rows = this.db
      .prepare(
        `SELECT account_id, requests, est_credits, first_used, last_used
         FROM session_usage WHERE session_id = ?`
      )
      .all(sessionId) as Array<{
      account_id: string
      requests: number
      est_credits: number
      first_used: number
      last_used: number
    }>
    if (rows.length === 0) return undefined
    return aggregateSessionRows(sessionId, undefined, undefined, rows)
  }

  /**
   * Recent sessions with tracked usage, newest first, each summed across the
   * accounts that served it and carrying the per-account breakdown.
   *
   * `limit` bounds the number of *sessions* returned, not raw rows, so a
   * session split over several accounts still counts once.
   */
  getRecentSessionUsage(limit = 20): SessionUsageRow[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, account_id, title, directory, requests, est_credits, first_used, last_used
         FROM session_usage ORDER BY last_used DESC`
      )
      .all() as Array<{
      session_id: string
      account_id: string
      title: string | null
      directory: string | null
      requests: number
      est_credits: number
      first_used: number
      last_used: number
    }>
    const bySession = new Map<
      string,
      { title: string | null; directory: string | null; rows: typeof rows }
    >()
    for (const r of rows) {
      let entry = bySession.get(r.session_id)
      if (!entry) {
        entry = { title: r.title, directory: r.directory, rows: [] }
        bySession.set(r.session_id, entry)
      }
      entry.rows.push(r)
    }
    return Array.from(bySession.entries())
      .map(([sessionId, e]) =>
        aggregateSessionRows(sessionId, e.title ?? undefined, e.directory ?? undefined, e.rows)
      )
      .sort((a, b) => b.lastUsed - a.lastUsed)
      .slice(0, limit)
  }

  /**
   * Heartbeat this instance's version + install path, and reap dead/stale rows.
   *
   * Keyed by pid so instances never clobber each other's row; the DB's own
   * locking makes the upsert race-free. A row whose pid is no longer alive, or
   * older than ttlMs, is dropped so the panel sees only live instances. Best
   * effort: a failure here must not affect a request or a usage sync.
   */
  heartbeatInstance(version: string, source: string | undefined, ttlMs = 120_000): void {
    const now = Date.now()
    this.db.exec('BEGIN TRANSACTION')
    try {
      this.db
        .prepare(
          `INSERT INTO plugin_instances (pid, version, source, last_seen)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(pid) DO UPDATE SET
             version = excluded.version,
             source = excluded.source,
             last_seen = excluded.last_seen`
        )
        .run(process.pid, version, source ?? null, now)
      // Reap rows older than the TTL, and any whose process is gone.
      const cutoff = now - ttlMs
      const stale = this.db.prepare('SELECT pid, last_seen FROM plugin_instances').all() as Array<{
        pid: number
        last_seen: number
      }>
      for (const row of stale) {
        if (row.pid === process.pid) continue
        const dead = (() => {
          try {
            process.kill(row.pid, 0)
            return false
          } catch {
            return true
          }
        })()
        if (dead || row.last_seen < cutoff) {
          this.db.prepare('DELETE FROM plugin_instances WHERE pid = ?').run(row.pid)
        }
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /** Live plugin instances (pid, version, install path), newest heartbeat first. */
  getPluginInstances(): Array<{
    pid: number
    version: string
    source?: string
    lastSeen: number
  }> {
    const rows = this.db
      .prepare(
        'SELECT pid, version, source, last_seen FROM plugin_instances ORDER BY last_seen DESC'
      )
      .all() as Array<{ pid: number; version: string; source: string | null; last_seen: number }>
    return rows.map((r) => ({
      pid: r.pid,
      version: r.version,
      source: r.source ?? undefined,
      lastSeen: r.last_seen
    }))
  }

  deleteConversationId(workspace: string, fingerprint: string): void {
    this.db
      .prepare('DELETE FROM conversations WHERE workspace = ? AND fingerprint = ?')
      .run(workspace, fingerprint)
  }

  /**
   * Persist a conversationId and agentContinuationId, clean up entries older than ttlDays (default 7).
   */
  setConversationId(
    workspace: string,
    fingerprint: string,
    convId: string,
    agentContinuationId: string,
    ttlDays = 7
  ): void {
    const now = Date.now()
    const cutoff = now - ttlDays * 24 * 60 * 60 * 1000
    this.db.exec('BEGIN TRANSACTION')
    try {
      this.db
        .prepare(
          `INSERT INTO conversations (workspace, fingerprint, conv_id, agent_continuation_id, last_used)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(workspace, fingerprint) DO UPDATE SET conv_id = excluded.conv_id, agent_continuation_id = excluded.agent_continuation_id, last_used = excluded.last_used`
        )
        .run(workspace, fingerprint, convId, agentContinuationId, now)
      this.db.prepare('DELETE FROM conversations WHERE last_used < ?').run(cutoff)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
}

export const kiroDb = new KiroDatabase()
