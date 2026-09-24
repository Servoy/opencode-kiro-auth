import type { SqliteDatabase } from './database-driver'

export function runMigrations(db: SqliteDatabase): void {
  migrateToUniqueRefreshToken(db)
  migrateRealEmailColumn(db)
  migrateUsageTable(db)
  migrateStartUrlColumn(db)
  migrateOidcRegionColumn(db)
  migrateDropRefreshTokenUniqueIndex(db)
  migrateConversationsTable(db)
  migrateReauthLockTable(db)
  migrateConversationsAgentContinuationId(db)
  migrateCollapseDuplicateAccounts(db)
  migrateModelCatalogTable(db)
  migrateSessionAccountsTable(db)
  migrateSessionUsageTable(db)
  migratePluginInstancesTable(db)
}

/**
 * Which plugin version each running instance is on, keyed by pid.
 *
 * OpenCode loads a separate plugin instance per project, and they can come from
 * different installs (npm global, cache, a local checkout), so the pool can be
 * version-split. Each instance heartbeats its own row; the panel warns when the
 * live rows disagree. Shared across projects like the other cross-instance
 * tables, and the DB's own locking makes the per-pid upsert race-free — no
 * read-merge-write on the JSON snapshot.
 */
function migratePluginInstancesTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_instances (
      pid       INTEGER PRIMARY KEY,
      version   TEXT    NOT NULL,
      source    TEXT,
      last_seen INTEGER NOT NULL
    )
  `)
}

/**
 * Per-session, per-account Kiro request counts — the basis for the panel's
 * session-cost estimate. Kiro bills per request (invocation), not per token, so
 * a request count is the honest unit; the panel apportions each account's
 * credit delta across the sessions that spent it, by their share of that
 * account's requests in the same window.
 *
 * The row is keyed on (session_id, account_id): one session can be served by
 * several accounts (rotation on rate-limit, or an explicit account switch), and
 * only the account that served a request may carry its credits. Aggregating
 * back to a per-session total is the panel's job. Shared across projects like
 * the other cross-instance tables: a session can be served from any open
 * OpenCode project instance, all against this one db.
 */
function migrateSessionUsageTable(db: SqliteDatabase): void {
  // An earlier unreleased shape keyed on session_id alone lacked account_id;
  // it never shipped and holds no data worth keeping, so drop and recreate to
  // the per-account shape rather than carry an ALTER path for pre-release rows.
  const hasAccountId = (
    db.prepare("PRAGMA table_info('session_usage')").all() as Array<{ name: string }>
  ).some((c) => c.name === 'account_id')
  const tableExists =
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_usage'")
        .all() as unknown[]
    ).length > 0
  if (tableExists && !hasAccountId) db.exec('DROP TABLE session_usage')
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_usage (
      session_id  TEXT    NOT NULL,
      account_id  TEXT    NOT NULL,
      title       TEXT,
      directory   TEXT,
      requests    INTEGER NOT NULL DEFAULT 0,
      est_credits REAL    NOT NULL DEFAULT 0,
      first_used  INTEGER NOT NULL,
      last_used   INTEGER NOT NULL,
      PRIMARY KEY (session_id, account_id)
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_usage_last_used ON session_usage(last_used)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_usage_account ON session_usage(account_id)')
}

/**
 * Which account served a session, so later turns go back to the same one.
 *
 * A conversationId is only valid on the account that created it, so a pool
 * rotating mid-conversation makes the service reject it. Shared across
 * projects for the same reason the catalog is.
 */
function migrateSessionAccountsTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_accounts (
      session_id TEXT    PRIMARY KEY,
      account_id TEXT    NOT NULL,
      last_used  INTEGER NOT NULL
    )
  `)
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_session_accounts_last_used ON session_accounts(last_used)'
  )
}

/**
 * Model context windows, shared by every project on this machine.
 *
 * OpenCode gives each project its own plugin module, so an in-memory cache is
 * held per project — with dozens open that was a catalog lookup each.
 */
function migrateModelCatalogTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_catalog (
      key          TEXT    PRIMARY KEY,
      models       TEXT    NOT NULL,
      attempted_at INTEGER NOT NULL,
      ttl_ms       INTEGER NOT NULL
    )
  `)
}

/**
 * Collapse rows that describe the same account, on every open.
 *
 * Two rules: same auth method and address is the same account; and IDC
 * placeholder addresses sharing a region and profile ARN are too, since those
 * addresses used to differ per sign-in. Freshest usable row wins.
 */
function migrateCollapseDuplicateAccounts(db: SqliteDatabase): void {
  collapse(
    db,
    `SELECT auth_method, email FROM accounts
     GROUP BY auth_method, email HAVING COUNT(*) > 1`,
    (group) => ({
      where: 'auth_method = ? AND email = ?',
      params: [group.auth_method, group.email]
    })
  )

  collapse(
    db,
    `SELECT COALESCE(region, '') AS region, COALESCE(profile_arn, '') AS profile_arn
     FROM accounts
     WHERE auth_method = 'idc' AND email LIKE 'idc-placeholder+%@awsapps.local'
     GROUP BY COALESCE(region, ''), COALESCE(profile_arn, '')
     HAVING COUNT(*) > 1`,
    (group) => ({
      where: `auth_method = 'idc' AND email LIKE 'idc-placeholder+%@awsapps.local'
              AND COALESCE(region, '') = ? AND COALESCE(profile_arn, '') = ?`,
      params: [group.region, group.profile_arn]
    })
  )
}

/** Delete every row a group query matches except the freshest usable one. */
function collapse(
  db: SqliteDatabase,
  groupQuery: string,
  toFilter: (group: any) => { where: string; params: unknown[] }
): void {
  const groups = db.prepare(groupQuery).all() as any[]

  for (const group of groups) {
    const { where, params } = toFilter(group)
    const rows = db
      .prepare(
        `SELECT id FROM accounts WHERE ${where}
         ORDER BY is_healthy DESC, expires_at DESC, last_used DESC`
      )
      .all(...(params as any[])) as any[]

    for (const row of rows.slice(1)) {
      db.prepare('DELETE FROM accounts WHERE id = ?').run(row.id)
    }
  }
}

function migrateConversationsTable(db: SqliteDatabase): void {
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'")
    .get()
  if (hasTable) return

  db.exec(`
    CREATE TABLE conversations (
      workspace   TEXT    NOT NULL,
      fingerprint TEXT    NOT NULL,
      conv_id     TEXT    NOT NULL,
      last_used   INTEGER NOT NULL,
      PRIMARY KEY (workspace, fingerprint)
    )
  `)
  db.exec('CREATE INDEX idx_conversations_last_used ON conversations(last_used)')
}

/**
 * Cross-instance advisory lock table, one row per (id, purpose).
 *
 * Originally a single-row table for the reauth handshake (id = 1, purpose
 * implicit). Repurposed to a generic lock by adding purpose — the reauth
 * lock (purpose = 'reauth') and the startup usage-sync lock (purpose =
 * 'usage_sync') coexist on the same id without blocking each other, so
 * one instance can be syncing usage while another is finishing a reauth.
 *
 * Upgrade from v2.3.0: rows had no purpose column and used (id) as PK; the
 * upgrade copies them as 'reauth' (the only purpose that existed before)
 * and rebuilds the table with the composite PK.
 */
function migrateReauthLockTable(db: SqliteDatabase): void {
  // Make sure the table exists with the current shape; CREATE first so
  // PRAGMA below has something to inspect on a fresh install.
  db.exec(`
    CREATE TABLE IF NOT EXISTS reauth_lock (
      id          INTEGER NOT NULL,
      purpose     TEXT    NOT NULL DEFAULT 'reauth',
      pid         INTEGER NOT NULL,
      acquired_at INTEGER NOT NULL,
      PRIMARY KEY (id, purpose)
    )
  `)
  // Upgrade from v2.3.0: rows had no purpose column and used (id) as PK.
  // Reap them into the new shape — the only purpose that existed then is
  // reauth, so the (id, 'reauth') row carries forward verbatim.
  const columns = db.prepare('PRAGMA table_info(reauth_lock)').all() as Array<{ name: string }>
  const hasPurpose = columns.some((c) => c.name === 'purpose')
  if (!hasPurpose) {
    db.exec(`
      ALTER TABLE reauth_lock RENAME TO reauth_lock_legacy;
      CREATE TABLE reauth_lock (
        id          INTEGER NOT NULL,
        purpose     TEXT    NOT NULL,
        pid         INTEGER NOT NULL,
        acquired_at INTEGER NOT NULL,
        PRIMARY KEY (id, purpose)
      );
      INSERT INTO reauth_lock (id, purpose, pid, acquired_at)
        SELECT id, 'reauth', pid, acquired_at FROM reauth_lock_legacy;
      DROP TABLE reauth_lock_legacy;
    `)
  }
}

function migrateConversationsAgentContinuationId(db: SqliteDatabase): void {
  const columns = db.prepare('PRAGMA table_info(conversations)').all() as any[]
  const names = new Set(columns.map((c: any) => c.name))
  if (!names.has('agent_continuation_id')) {
    db.exec('ALTER TABLE conversations ADD COLUMN agent_continuation_id TEXT')
  }
}

function migrateToUniqueRefreshToken(db: SqliteDatabase): void {
  const hasIndex = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_refresh_token_unique'"
    )
    .get()

  if (hasIndex) return

  db.exec('BEGIN TRANSACTION')
  try {
    const duplicates = db
      .prepare(
        `
        SELECT refresh_token, COUNT(*) as count 
        FROM accounts 
        GROUP BY refresh_token 
        HAVING count > 1
      `
      )
      .all() as any[]

    for (const dup of duplicates) {
      const accounts = db
        .prepare(
          'SELECT * FROM accounts WHERE refresh_token = ? ORDER BY last_used DESC, expires_at DESC'
        )
        .all(dup.refresh_token) as any[]

      if (accounts.length > 1) {
        const keep = accounts[0]
        const remove = accounts.slice(1)

        const mergedUsedCount = Math.max(...accounts.map((a: any) => a.used_count || 0))
        const mergedLimitCount = Math.max(...accounts.map((a: any) => a.limit_count || 0))
        const mergedLastUsed = Math.max(...accounts.map((a: any) => a.last_used || 0))
        const mergedFailCount = Math.max(...accounts.map((a: any) => a.fail_count || 0))

        db.prepare(
          `
            UPDATE accounts SET 
              used_count = ?, 
              limit_count = ?, 
              last_used = ?,
              fail_count = ?
            WHERE id = ?
          `
        ).run(mergedUsedCount, mergedLimitCount, mergedLastUsed, mergedFailCount, keep.id)

        for (const acc of remove) {
          db.prepare('DELETE FROM accounts WHERE id = ?').run(acc.id)
        }
      }
    }

    db.exec('CREATE UNIQUE INDEX idx_refresh_token_unique ON accounts(refresh_token)')
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

function migrateRealEmailColumn(db: SqliteDatabase): void {
  const columns = db.prepare('PRAGMA table_info(accounts)').all() as any[]
  const names = new Set(columns.map((c) => c.name))
  if (names.has('real_email')) {
    db.exec('BEGIN TRANSACTION')
    try {
      db.exec(
        "UPDATE accounts SET email = real_email WHERE real_email IS NOT NULL AND real_email != '' AND email LIKE 'builder-id@aws.amazon.com%'"
      )
      db.exec(`
          CREATE TABLE accounts_new (
            id TEXT PRIMARY KEY, email TEXT NOT NULL, auth_method TEXT NOT NULL,
            region TEXT NOT NULL, oidc_region TEXT, client_id TEXT, client_secret TEXT, profile_arn TEXT,
            start_url TEXT,
            refresh_token TEXT NOT NULL, access_token TEXT NOT NULL, expires_at INTEGER NOT NULL,
            rate_limit_reset INTEGER DEFAULT 0, is_healthy INTEGER DEFAULT 1, unhealthy_reason TEXT,
            recovery_time INTEGER, fail_count INTEGER DEFAULT 0, last_used INTEGER DEFAULT 0,
            used_count INTEGER DEFAULT 0, limit_count INTEGER DEFAULT 0, last_sync INTEGER DEFAULT 0
          )
        `)
      db.exec(`
          INSERT INTO accounts_new (id, email, auth_method, region, oidc_region, client_id, client_secret, profile_arn, start_url, refresh_token, access_token, expires_at, rate_limit_reset, is_healthy, unhealthy_reason, recovery_time, fail_count, last_used, used_count, limit_count, last_sync)
          SELECT id, email, auth_method, region, NULL, client_id, client_secret, profile_arn, NULL, refresh_token, access_token, expires_at, COALESCE(rate_limit_reset, 0), COALESCE(is_healthy, 1), unhealthy_reason, recovery_time, COALESCE(fail_count, 0), COALESCE(last_used, 0), 0, 0, 0 FROM accounts
        `)
      db.exec('DROP TABLE accounts')
      db.exec('ALTER TABLE accounts_new RENAME TO accounts')
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
    }
  } else {
    const needed: Record<string, string> = {
      fail_count: 'INTEGER DEFAULT 0',
      used_count: 'INTEGER DEFAULT 0',
      limit_count: 'INTEGER DEFAULT 0',
      last_sync: 'INTEGER DEFAULT 0'
    }
    for (const [n, d] of Object.entries(needed)) {
      if (!names.has(n)) db.exec(`ALTER TABLE accounts ADD COLUMN ${n} ${d}`)
    }
  }
}

function migrateUsageTable(db: SqliteDatabase): void {
  const hasUsageTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='usage'")
    .get()
  if (hasUsageTable) {
    db.exec(`
        UPDATE accounts SET 
          used_count = COALESCE((SELECT used_count FROM usage WHERE usage.account_id = accounts.id), used_count),
          limit_count = COALESCE((SELECT limit_count FROM usage WHERE usage.account_id = accounts.id), limit_count),
          last_sync = COALESCE((SELECT last_sync FROM usage WHERE usage.account_id = accounts.id), last_sync)
      `)
    db.exec('DROP TABLE usage')
  }
}

function migrateStartUrlColumn(db: SqliteDatabase): void {
  const columns = db.prepare('PRAGMA table_info(accounts)').all() as any[]
  const names = new Set(columns.map((c) => c.name))
  if (!names.has('start_url')) {
    db.exec('ALTER TABLE accounts ADD COLUMN start_url TEXT')
  }
}

function migrateOidcRegionColumn(db: SqliteDatabase): void {
  const columns = db.prepare('PRAGMA table_info(accounts)').all() as any[]
  const names = new Set(columns.map((c) => c.name))
  if (!names.has('oidc_region')) {
    db.exec('ALTER TABLE accounts ADD COLUMN oidc_region TEXT')
  }
  // Backfill: historically `region` was used for both service + OIDC.
  db.exec("UPDATE accounts SET oidc_region = region WHERE oidc_region IS NULL OR oidc_region = ''")
}

function migrateDropRefreshTokenUniqueIndex(db: SqliteDatabase): void {
  // Drop the UNIQUE index on refresh_token — it was only needed for ON CONFLICT(refresh_token)
  // upsert mechanics. Now that we use ON CONFLICT(id), this index is unnecessary and actively
  // harmful: duplicate rows (same account, different legacy vs hash id) share the same
  // refresh_token, causing UNIQUE constraint violations on every upsert.
  db.exec('DROP INDEX IF EXISTS idx_refresh_token_unique')

  // Clean up duplicate rows: same email + same refresh_token but different ids.
  // Keep the deterministic hash id (64-char hex), delete legacy kiro-cli-sync-* rows.
  const duplicates = db
    .prepare(
      `SELECT email, refresh_token FROM accounts
       GROUP BY email, refresh_token
       HAVING COUNT(*) > 1`
    )
    .all() as any[]

  for (const dup of duplicates) {
    const rows = db
      .prepare(
        `SELECT id FROM accounts WHERE email = ? AND refresh_token = ?
         ORDER BY
           CASE WHEN id LIKE 'kiro-cli-sync-%' THEN 1 ELSE 0 END ASC,
           last_used DESC, expires_at DESC`
      )
      .all(dup.email, dup.refresh_token) as any[]

    // Keep the first row (deterministic hash id preferred), delete the rest
    for (const row of rows.slice(1)) {
      db.prepare('DELETE FROM accounts WHERE id = ?').run(row.id)
    }
  }
}
