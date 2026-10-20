import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { AccountCache } from '../infrastructure/database/account-cache.js'
import { AccountRepository } from '../infrastructure/database/account-repository.js'
import { kiroDb } from '../plugin/storage/sqlite.js'
import type { ManagedAccount } from '../plugin/types.js'

// The real repository against the real kiroDb singleton. Under NODE_ENV=test the
// store already lives in a tmpdir (see config/paths.ts), so this exercises the
// genuine row mapping, caching and invalidation the runtime uses — no stub.

function account(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: 'acc-1',
    email: 'a@example.com',
    authMethod: 'idc',
    region: 'eu-central-1',
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

let repo: AccountRepository

beforeEach(async () => {
  for (const row of kiroDb.getAccounts()) await kiroDb.deleteAccount(row.id)
  repo = new AccountRepository(new AccountCache(60_000))
})

afterEach(async () => {
  for (const row of kiroDb.getAccounts()) await kiroDb.deleteAccount(row.id)
})

describe('AccountRepository', () => {
  test('findAll maps every stored row into the account shape', async () => {
    await kiroDb.upsertAccount(
      account({ id: 'a', email: 'a@x', profileArn: 'arn:a', usedCount: 7, limitCount: 100 })
    )

    const all = await repo.findAll()
    const a = all.find((x) => x.id === 'a')!

    expect(a.email).toBe('a@x')
    expect(a.authMethod).toBe('idc')
    expect(a.profileArn).toBe('arn:a')
    expect(a.usedCount).toBe(7)
    expect(a.limitCount).toBe(100)
    expect(a.isHealthy).toBe(true)
  })

  test('findById returns the matching account, or null when absent', async () => {
    await kiroDb.upsertAccount(account({ id: 'a' }))

    expect((await repo.findById('a'))?.id).toBe('a')
    expect(await repo.findById('missing')).toBeNull()
  })

  test('findHealthyAccounts filters out the unhealthy ones', async () => {
    await kiroDb.upsertAccount(account({ id: 'ok', isHealthy: true }))
    await kiroDb.upsertAccount(
      account({ id: 'bad', isHealthy: false, unhealthyReason: 'unauthorized' })
    )

    const healthy = await repo.findHealthyAccounts()
    expect(healthy.map((a) => a.id)).toEqual(['ok'])
  })

  test('findAll serves a second call from cache until invalidated', async () => {
    await kiroDb.upsertAccount(account({ id: 'a' }))
    await repo.findAll() // warms the cache

    // Write a new row straight to the store, bypassing the repository.
    await kiroDb.upsertAccount(account({ id: 'b' }))

    // Still one, because the cache has not been invalidated.
    expect((await repo.findAll()).map((a) => a.id)).toEqual(['a'])

    repo.invalidateCache()
    expect((await repo.findAll()).map((a) => a.id).sort()).toEqual(['a', 'b'])
  })

  test('save writes through and refreshes that id on the next read', async () => {
    await repo.save(account({ id: 'a', email: 'first@x' }))
    expect((await repo.findById('a'))?.email).toBe('first@x')

    await repo.save(account({ id: 'a', email: 'second@x' }))
    expect((await repo.findById('a'))?.email).toBe('second@x')
  })

  test('delete removes the account from the store', async () => {
    await repo.save(account({ id: 'a' }))
    await repo.delete('a')
    expect(await repo.findById('a')).toBeNull()
  })

  test('batchSave persists many and invalidates the whole cache', async () => {
    await repo.findAll() // warm empty
    await repo.batchSave([account({ id: 'a' }), account({ id: 'b' })])

    const all = await repo.findAll()
    expect(all.map((a) => a.id).sort()).toEqual(['a', 'b'])
  })
})
