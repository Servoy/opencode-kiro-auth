import { describe, expect, test } from 'bun:test'
import { mergeAccounts } from '../plugin/storage/locked-operations.js'
import type { ManagedAccount } from '../plugin/types.js'
import { updateAccountQuota } from '../plugin/usage.js'

function account(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: 'acc-1',
    email: 'user@example.com',
    authMethod: 'idc',
    region: 'eu-central-1',
    refreshToken: 'refresh',
    accessToken: 'access',
    expiresAt: Date.now() + 60_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 0,
    limitCount: 0,
    ...overrides
  } as ManagedAccount
}

describe('usage merge', () => {
  test('a fresh reading wins even when it is lower than the stored one', () => {
    // Quotas reset. Merging with Math.max ratcheted used_count up forever, so
    // the stored figure drifted far above reality — skewing 'lowest-usage'
    // account selection and every usage number shown to the user.
    const stored = account({ usedCount: 7444, limitCount: 10_000 })
    const fresh = account({ usedCount: 1280, limitCount: 10_000 })
    updateAccountQuota(fresh, { usedCount: 1280, limitCount: 10_000 })

    const [merged] = mergeAccounts([stored], [fresh])

    expect(merged!.usedCount).toBe(1280)
  })

  test('an account with no fresh reading cannot zero the stored usage', () => {
    const stored = account({ usedCount: 7444, limitCount: 10_000 })
    const untouched = account({ usedCount: 0, limitCount: 0 })

    const [merged] = mergeAccounts([stored], [untouched])

    expect(merged!.usedCount).toBe(7444)
    expect(merged!.limitCount).toBe(10_000)
  })

  test('the newer of two readings wins', () => {
    const older = account({ usedCount: 500, usageUpdatedAt: 1000 })
    const newer = account({ usedCount: 100, usageUpdatedAt: 2000 })

    expect(mergeAccounts([older], [newer])[0]!.usedCount).toBe(100)
    // ...and a stale incoming reading does not clobber a newer stored one.
    expect(mergeAccounts([newer], [older])[0]!.usedCount).toBe(100)
  })

  test('a usage sync does not mark the account as Kiro CLI-synced', () => {
    // lastSync doubles as "this account came from the Kiro CLI"; stamping it on
    // every usage refresh would make native IDC accounts look CLI-managed and
    // eligible for stale-account pruning.
    const acc = account()
    updateAccountQuota(acc, { usedCount: 5, limitCount: 100 })

    expect(acc.lastSync).toBeUndefined()
    expect(acc.usageUpdatedAt).toBeGreaterThan(0)
  })
})
