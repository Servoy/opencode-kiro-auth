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
    await db.upsertAccount(account({ id: 'real-1', email: 'a@servoy.com', refreshToken: 'r-1' }))
    await db.upsertAccount(account({ id: 'real-2', email: 'b@servoy.com', refreshToken: 'r-2' }))

    expect(reopen().getAccounts()).toHaveLength(2)
  })

  test('one address is one account, whatever the row says', async () => {
    await db.upsertAccount(
      account({ id: 'old-scheme', email: 'rene@servoy.com', refreshToken: 'r-1', expiresAt: 1_000 })
    )
    await db.upsertAccount(
      account({ id: 'new-scheme', email: 'rene@servoy.com', refreshToken: 'r-2', expiresAt: 9_999 })
    )

    const remaining = reopen().getAccounts()

    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.id).toBe('new-scheme')
  })

  test('the same address on two profiles is still one person', async () => {
    await db.upsertAccount(
      account({
        id: 'profile-a',
        email: 'rene@servoy.com',
        refreshToken: 'r-1',
        profileArn: PROFILE,
        expiresAt: 9_999
      })
    )
    await db.upsertAccount(
      account({
        id: 'profile-b',
        email: 'rene@servoy.com',
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
    await db.upsertAccount(account({ id: 'rene', email: 'rene@servoy.com', refreshToken: 'r-1' }))
    await db.upsertAccount(account({ id: 'mees', email: 'mees@servoy.com', refreshToken: 'r-2' }))

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
})
