import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KiroDatabase } from '../plugin/storage/sqlite.js'
import { makePlaceholderEmail } from '../plugin/sync/kiro-cli-parser.js'
import type { ManagedAccount } from '../plugin/types.js'

const PROFILE = 'arn:aws:codewhisperer:eu-central-1:428597928572:profile/HE7XVERQ9VXW'

describe('placeholder identity', () => {
  test('an IDC placeholder survives the clientId being re-issued', () => {
    const first = makePlaceholderEmail('idc', 'eu-central-1', 'client-A', PROFILE)
    const second = makePlaceholderEmail('idc', 'eu-central-1', 'client-B', PROFILE)

    expect(first).toBe(second)
  })

  test('a different profile is still a different identity', () => {
    expect(makePlaceholderEmail('idc', 'eu-central-1', 'c', PROFILE)).not.toBe(
      makePlaceholderEmail('idc', 'eu-central-1', 'c', `${PROFILE}-other`)
    )
  })

  test('a different region is still a different identity', () => {
    expect(makePlaceholderEmail('idc', 'eu-central-1', 'c', PROFILE)).not.toBe(
      makePlaceholderEmail('idc', 'us-east-1', 'c', PROFILE)
    )
  })

  test('desktop accounts keep the clientId, which does not rotate for them', () => {
    expect(makePlaceholderEmail('desktop', 'us-east-1', 'client-A')).not.toBe(
      makePlaceholderEmail('desktop', 'us-east-1', 'client-B')
    )
  })
})

describe('collapsing accounts that piled up', () => {
  let dir: string
  let dbPath: string
  let db: KiroDatabase

  function account(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
    return {
      id: 'acc',
      email: 'idc-placeholder+aaaaaaaaaaaaaaaa@awsapps.local',
      authMethod: 'idc',
      region: 'eu-central-1',
      profileArn: PROFILE,
      refreshToken: 'r',
      accessToken: 'a',
      expiresAt: Date.now() + 3_600_000,
      rateLimitResetTime: 0,
      isHealthy: true,
      failCount: 0,
      lastUsed: 0,
      usedCount: 0,
      limitCount: 0,
      ...overrides
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kiro-dup-'))
    dbPath = join(dir, 'test.db')
    db = new KiroDatabase(dbPath)
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function reopen(): KiroDatabase {
    db.close()
    db = new KiroDatabase(dbPath)
    return db
  }

  test('eight rows for one account collapse to the freshest one', async () => {
    for (let i = 0; i < 8; i++) {
      await db.upsertAccount(
        account({
          id: `dup-${i}`,
          email: `idc-placeholder+${String(i).repeat(16)}@awsapps.local`,
          expiresAt: 1_000 + i,
          refreshToken: `r-${i}`
        })
      )
    }

    const remaining = reopen().getAccounts()

    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.id).toBe('dup-7')
  })

  test('a healthy row is kept over a fresher unhealthy one', async () => {
    await db.upsertAccount(
      account({ id: 'healthy', refreshToken: 'r-1', expiresAt: 1_000, isHealthy: true })
    )
    await db.upsertAccount(
      account({
        id: 'broken',
        refreshToken: 'r-2',
        expiresAt: 9_999,
        isHealthy: false,
        unhealthyReason: 'unauthorized'
      })
    )

    const remaining = reopen().getAccounts()

    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.id).toBe('healthy')
  })

  test('accounts with a real address are never touched', async () => {
    await db.upsertAccount(account({ id: 'real-1', email: 'a@example.com', refreshToken: 'r-1' }))
    await db.upsertAccount(account({ id: 'real-2', email: 'b@example.com', refreshToken: 'r-2' }))

    expect(reopen().getAccounts()).toHaveLength(2)
  })

  test('one address is one account, whatever the row says', async () => {
    await db.upsertAccount(
      account({
        id: 'old-scheme',
        email: 'user@example.com',
        refreshToken: 'r-1',
        expiresAt: 1_000
      })
    )
    await db.upsertAccount(
      account({
        id: 'new-scheme',
        email: 'user@example.com',
        refreshToken: 'r-2',
        expiresAt: 9_999
      })
    )

    const remaining = reopen().getAccounts()

    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.id).toBe('new-scheme')
  })

  test('the same address on two profiles is still one person', async () => {
    await db.upsertAccount(
      account({
        id: 'profile-a',
        email: 'user@example.com',
        refreshToken: 'r-1',
        profileArn: PROFILE,
        expiresAt: 9_999
      })
    )
    await db.upsertAccount(
      account({
        id: 'profile-b',
        email: 'user@example.com',
        refreshToken: 'r-2',
        profileArn: `${PROFILE}-other`,
        expiresAt: 1_000
      })
    )

    const remaining = reopen().getAccounts()

    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.id).toBe('profile-a')
  })

  test('two people on one machine both survive', async () => {
    await db.upsertAccount(
      account({ id: 'alice', email: 'alice@example.com', refreshToken: 'r-1' })
    )
    await db.upsertAccount(account({ id: 'bob', email: 'bob@example.com', refreshToken: 'r-2' }))

    expect(reopen().getAccounts()).toHaveLength(2)
  })

  test('placeholders on different profiles stay separate', async () => {
    const other = `${PROFILE}-other`
    await db.upsertAccount(
      account({
        id: 'profile-a',
        email: makePlaceholderEmail('idc', 'eu-central-1', 'c', PROFILE),
        refreshToken: 'r-1',
        profileArn: PROFILE
      })
    )
    await db.upsertAccount(
      account({
        id: 'profile-b',
        email: makePlaceholderEmail('idc', 'eu-central-1', 'c', other),
        refreshToken: 'r-2',
        profileArn: other
      })
    )

    expect(reopen().getAccounts()).toHaveLength(2)
  })

  // One API key gave two rows: a usage lookup that returned an email on one
  // start and a placeholder on another produced two emails for the same key.
  // The (auth_method, email) rule cannot merge those, so the fingerprint
  // (refresh_token) rule must. Freshest usable row kept.
  test('one API key with two emails collapses to the healthy row, not the fresher broken one', async () => {
    // The broken placeholder row is written LAST (fresher last_used), so a
    // plain last-used tie-break would keep the dead row. The apikey collapse is
    // health-aware (is_healthy DESC first), so the usable real-email row wins —
    // this is what the fingerprint rule adds over the generic refresh-token
    // dedup, and the ordering here is what makes the test prove it.
    const FP = 'apikey:0123456789abcdef'
    await db.upsertAccount(
      account({
        id: 'apikey-real',
        authMethod: 'apikey',
        email: 'user@example.com',
        refreshToken: FP,
        profileArn: PROFILE,
        expiresAt: 0,
        lastUsed: 1_000,
        isHealthy: true
      })
    )
    await db.upsertAccount(
      account({
        id: 'apikey-placeholder',
        authMethod: 'apikey',
        email: 'apikey-placeholder+aaaaaaaaaaaaaaaa@awsapps.local',
        refreshToken: FP,
        profileArn: PROFILE,
        expiresAt: 0,
        lastUsed: 9_999, // fresher — a last-used-only rule would keep this dead row
        isHealthy: false,
        unhealthyReason: 'unauthorized'
      })
    )

    const remaining = reopen().getAccounts() as any[]

    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.id).toBe('apikey-real')
    expect(remaining[0]!.auth_method).toBe('apikey')
  })

  // The real-user state the fresh-db test above cannot reach: a db that has
  // ALREADY run migrateToUniqueRefreshToken (its index was created, then dropped
  // by a later version). That one-time migration never fires again, so the two
  // apikey rows can only be merged by the every-open apikey collapse. Insert the
  // rows via raw SQL AFTER a first open so the one-time migration has passed,
  // then reopen and assert they fold. This is the test that actually guards the
  // bug a fresh-db test gives false confidence about.
  test('two apikey rows collapse on an already-migrated db, not just a fresh one', async () => {
    const FP = 'apikey:1234567890abcdef'
    // First open runs (and completes) all one-time migrations on an empty db.
    // Reach the raw driver to seed the post-migration state directly.
    const raw = (db as unknown as { db: any }).db
    const insert = (id: string, email: string, healthy: number, lastUsed: number) =>
      raw
        .prepare(
          `INSERT INTO accounts (id, email, auth_method, region, profile_arn, refresh_token,
             access_token, expires_at, rate_limit_reset, is_healthy, fail_count, last_used,
             used_count, limit_count)
           VALUES (?, ?, 'apikey', 'eu-central-1', ?, ?, 'a', 0, 0, ?, 0, ?, 0, 0)`
        )
        .run(id, email, PROFILE, FP, healthy, lastUsed)

    insert('real', 'user@example.com', 1, 1_000)
    insert('placeholder', 'apikey-placeholder+aaaaaaaaaaaaaaaa@awsapps.local', 0, 9_999)
    expect(raw.prepare('SELECT COUNT(*) AS n FROM accounts').get().n).toBe(2)

    const remaining = reopen().getAccounts() as any[]

    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.id).toBe('real')
  })

  test('two different API keys both survive', async () => {
    await db.upsertAccount(
      account({
        id: 'key-a',
        authMethod: 'apikey',
        email: 'a@example.com',
        refreshToken: 'apikey:aaaaaaaaaaaaaaaa',
        expiresAt: 0
      })
    )
    await db.upsertAccount(
      account({
        id: 'key-b',
        authMethod: 'apikey',
        email: 'b@example.com',
        refreshToken: 'apikey:bbbbbbbbbbbbbbbb',
        expiresAt: 0
      })
    )

    expect(reopen().getAccounts()).toHaveLength(2)
  })

  // Diana's real db: the same real address + IDC profileArn under two id
  // schemes (an old row where the clientId was hashed into the id, and the
  // current email:idc:arn id). Both healthy-looking rows lingered and the
  // panel showed two different percentages for one account.
  test('same real email + IDC profileArn collapses across id schemes', async () => {
    await db.upsertAccount(
      account({
        id: 'old-scheme-with-clientid-in-hash',
        email: 'user@example.com',
        clientId: 'client-old',
        refreshToken: 'r-old',
        profileArn: PROFILE,
        expiresAt: 1_000,
        isHealthy: false,
        usedCount: 1944.87,
        limitCount: 5000
      })
    )
    await db.upsertAccount(
      account({
        id: 'canonical-email-idc-arn',
        email: 'user@example.com',
        clientId: 'client-new',
        refreshToken: 'r-new',
        profileArn: PROFILE,
        expiresAt: 9_999,
        isHealthy: true,
        usedCount: 3842.64,
        limitCount: 5000
      })
    )

    const remaining = reopen().getAccounts()

    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.id).toBe('canonical-email-idc-arn')
  })

  // Env API key + an old IDC/ARN login on the same subscription: optie 2 — the
  // key supersedes the login (same profile ARN) so the pool does not go into
  // two-account mode over one quota.
  test('an API key drops an IDC login that shares its profile ARN', async () => {
    await db.upsertAccount(
      account({
        id: 'idc-login',
        authMethod: 'idc',
        email: 'user@example.com',
        profileArn: PROFILE,
        refreshToken: 'r-idc',
        expiresAt: 9_999,
        isHealthy: true
      })
    )
    await db.upsertAccount(
      account({
        id: 'apikey',
        authMethod: 'apikey',
        email: 'user@example.com',
        profileArn: PROFILE,
        refreshToken: 'apikey:ffffffffffffffff',
        expiresAt: 0,
        isHealthy: true
      })
    )

    const remaining = reopen().getAccounts() as any[]

    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.id).toBe('apikey')
    expect(remaining[0]!.auth_method).toBe('apikey')
  })

  test('an API key leaves an IDC login on a DIFFERENT profile ARN alone', async () => {
    await db.upsertAccount(
      account({
        id: 'other-idc',
        authMethod: 'idc',
        email: 'other@example.com',
        profileArn: `${PROFILE}-other`,
        refreshToken: 'r-other',
        expiresAt: 9_999,
        isHealthy: true
      })
    )
    await db.upsertAccount(
      account({
        id: 'apikey',
        authMethod: 'apikey',
        email: 'user@example.com',
        profileArn: PROFILE,
        refreshToken: 'apikey:ffffffffffffffff',
        expiresAt: 0,
        isHealthy: true
      })
    )

    expect(reopen().getAccounts()).toHaveLength(2)
  })
})
