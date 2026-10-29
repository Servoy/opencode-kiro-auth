import { describe, expect, test } from 'bun:test'
import {
  evaluateAccount,
  isPermanentlyUnusable,
  isUsableAccount,
  shouldSkipUsageResync
} from '../plugin/account-usability'
import type { ManagedAccount } from '../plugin/types'

function acc(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: 'id',
    email: 'e@x.com',
    authMethod: 'idc',
    region: 'eu-central-1',
    profileArn: 'arn:aws:codewhisperer:eu-central-1:1:profile/A',
    refreshToken: 'r',
    accessToken: 'a',
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    ...overrides
  }
}

describe('evaluateAccount invariants', () => {
  test('healthy account is usable', () => {
    expect(isUsableAccount(acc())).toBe(true)
  })

  test('IDC without profileArn is permanently unusable', () => {
    const a = acc({ profileArn: undefined })
    expect(isUsableAccount(a)).toBe(false)
    expect(isPermanentlyUnusable(a)).toBe(true)
  })

  test('IDC with empty-string profileArn is permanently unusable', () => {
    const a = acc({ profileArn: '' })
    expect(isPermanentlyUnusable(a)).toBe(true)
  })

  test('desktop account without profileArn is fine', () => {
    const a = acc({ authMethod: 'desktop', profileArn: undefined })
    expect(isUsableAccount(a)).toBe(true)
  })

  test('missing tokens are permanently unusable', () => {
    expect(isPermanentlyUnusable(acc({ accessToken: '' }))).toBe(true)
    expect(isPermanentlyUnusable(acc({ refreshToken: '' }))).toBe(true)
  })

  test('permanent error reason is permanently unusable', () => {
    const a = acc({ isHealthy: false, unhealthyReason: 'invalid_grant', failCount: 1 })
    expect(isPermanentlyUnusable(a)).toBe(true)
  })

  test('rate-limited is temporarily unusable, not permanent', () => {
    const a = acc({ rateLimitResetTime: Date.now() + 60_000 })
    const v = evaluateAccount(a)
    expect(v.usable).toBe(false)
    expect(isPermanentlyUnusable(a)).toBe(false)
  })

  test('unhealthy within recovery window is temporary', () => {
    const a = acc({ isHealthy: false, failCount: 3, recoveryTime: Date.now() + 60_000 })
    expect(isUsableAccount(a)).toBe(false)
    expect(isPermanentlyUnusable(a)).toBe(false)
  })

  test('unhealthy past recovery window is usable again', () => {
    const a = acc({ isHealthy: false, failCount: 3, recoveryTime: Date.now() - 1000 })
    expect(isUsableAccount(a)).toBe(true)
  })

  test('failCount at threshold is permanently unusable', () => {
    const a = acc({ isHealthy: false, failCount: 10, recoveryTime: Date.now() - 1000 })
    expect(isPermanentlyUnusable(a)).toBe(true)
  })
})

describe('shouldSkipUsageResync', () => {
  test('healthy accounts are not skipped (the caller only asks about unhealthy ones)', () => {
    expect(shouldSkipUsageResync(acc())).toBe(false)
  })

  test('a quota-exhausted account past its recovery window is re-synced', () => {
    // The real regression: failCount 10, "reached the limit", recovery elapsed.
    const a = acc({
      isHealthy: false,
      failCount: 10,
      unhealthyReason: 'You have reached the limit.',
      recoveryTime: Date.now() - 60_000
    })
    expect(shouldSkipUsageResync(a)).toBe(false)
  })

  test('an account still inside its recovery window is skipped', () => {
    const a = acc({
      isHealthy: false,
      failCount: 10,
      unhealthyReason: 'You have reached the limit.',
      recoveryTime: Date.now() + 3_600_000
    })
    expect(shouldSkipUsageResync(a)).toBe(true)
  })

  test('a permanent-error account is skipped (a sync cannot revive it)', () => {
    const a = acc({ isHealthy: false, failCount: 10, unhealthyReason: 'ExpiredTokenException' })
    expect(shouldSkipUsageResync(a)).toBe(true)
  })

  test('an IDC account without a profileArn is skipped', () => {
    const a = acc({ isHealthy: false, profileArn: undefined })
    expect(shouldSkipUsageResync(a)).toBe(true)
  })

  test('an account missing a token is skipped', () => {
    expect(shouldSkipUsageResync(acc({ isHealthy: false, accessToken: '' }))).toBe(true)
  })
})
