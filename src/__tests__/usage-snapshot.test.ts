import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ManagedAccount } from '../plugin/types.js'
import { _atomicReplaceForTest, buildAccountSnapshot } from '../plugin/usage-snapshot.js'
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
    const snap = buildAccountSnapshot(makeAccount(), usage, 1_000)

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

  test('a fresh nextDateReset is remembered on the account for later syncs', () => {
    const account = makeAccount()
    const withReset: UsageResult = { usedCount: 1, limitCount: 10, nextDateReset: 1790812800 }
    const snap = buildAccountSnapshot(account, withReset, 1_000)
    expect(snap.resetAt).toBe(1790812800 * 1000)
    expect(account.resetAt).toBe(1790812800 * 1000)
  })

  test('resetAt falls back to the last known value when a sync omits nextDateReset', () => {
    // Some getUsageLimits param combinations drop nextDateReset; the panel's
    // reset date must not flicker away between syncs.
    const account = makeAccount({ resetAt: 1790812800 * 1000 })
    const withoutReset: UsageResult = { usedCount: 2, limitCount: 10 }
    const snap = buildAccountSnapshot(account, withoutReset, 1_000)
    expect(snap.resetAt).toBe(1790812800 * 1000)
  })

  test('resetAt is undefined when neither the sync nor the account has one', () => {
    const snap = buildAccountSnapshot(makeAccount(), { usedCount: 1, limitCount: 10 }, 1_000)
    expect(snap.resetAt).toBeUndefined()
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
