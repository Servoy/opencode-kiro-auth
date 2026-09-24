import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Capture logger calls so the lock-held test can assert no warning was logged.
const warnings: string[] = []
mock.module('../plugin/sync/kiro-cli.js', () => ({
  syncFromKiroCli: () => Promise.resolve(),
  writeToKiroCli: () => Promise.resolve()
}))
mock.module('../plugin/logger.js', () => ({
  debug: () => {},
  error: () => {},
  log: () => {},
  warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')),
  setDebugEnabled: () => {},
  getTimestamp: () => '2026-09-24T00:00:00.000Z',
  logApiError: () => {},
  logApiRequest: () => {},
  logApiResponse: () => {}
}))
const loggerMock: { warnings: string[]; warn: () => void } = {
  warnings,
  warn: () => {}
}

mock.module('../kiro/auth.js', () => ({
  decodeRefreshToken: (t: string) => ({ refreshToken: t }),
  encodeRefreshToken: (p: any) => p.refreshToken,
  accessTokenExpired: () => false
}))

import { AuthHandler } from '../core/auth/auth-handler.js'
import type { KiroAuthDetails, ManagedAccount } from '../plugin/types.js'

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

function makeAuth(): KiroAuthDetails {
  return {
    refresh: 'refresh-token',
    access: 'access-token',
    expires: Date.now() + 3600000, // not expired -> no refresh attempted
    authMethod: 'idc',
    region: 'eu-central-1',
    profileArn: 'arn:aws:codewhisperer:eu-central-1:000000:profile/ABC'
  }
}

function makeManager(acc: ManagedAccount) {
  return {
    getAccounts: () => [acc],
    toAuthDetails: () => makeAuth(),
    updateUsage: () => {}
  }
}

const fakeRepo: any = {
  batchSave: async () => {},
  invalidateCache: () => {},
  findAll: async () => []
}

const CREDIT_RESPONSE = JSON.stringify({
  usageBreakdownList: [
    {
      freeTrialInfo: null,
      currentUsage: 70,
      currentUsageWithPrecision: 70.45,
      usageLimit: 10000,
      usageLimitWithPrecision: 10000,
      displayNamePlural: 'Credits',
      resourceType: 'CREDIT'
    }
  ],
  userInfo: { email: 'test@example.com' }
})

describe('AuthHandler.refreshUsageFromApi', () => {
  // A held lock leaks into the next test in the shared Bun process; start clean.
  beforeEach(async () => {
    const { kiroDb } = await import('../plugin/storage/sqlite.js')
    kiroDb.releaseUsageSyncLock()
  })

  test('fetches live usage and updates the account with dashboard credits', async () => {
    const acc = makeAccount({ usedCount: 4292, limitCount: 10000 }) // stale prior-period value
    const handler = new AuthHandler(
      { usage_tracking_enabled: true, token_expiry_buffer_ms: 300000, auto_sync_kiro_cli: false },
      fakeRepo
    )
    handler.setAccountManager(makeManager(acc))

    const original = globalThis.fetch
    globalThis.fetch = mock(async () => new Response(CREDIT_RESPONSE, { status: 200 })) as any
    try {
      await handler.refreshUsageFromApi()
      expect(acc.usedCount).toBe(70.45)
      expect(acc.limitCount).toBe(10000)
    } finally {
      globalThis.fetch = original
    }
  })

  test('keeps stored value when the live fetch fails', async () => {
    const acc = makeAccount({ usedCount: 70.45, limitCount: 10000 })
    const handler = new AuthHandler(
      { usage_tracking_enabled: true, token_expiry_buffer_ms: 300000, auto_sync_kiro_cli: false },
      fakeRepo
    )
    handler.setAccountManager(makeManager(acc))

    const original = globalThis.fetch
    globalThis.fetch = mock(async () => new Response('boom', { status: 500 })) as any
    try {
      await handler.refreshUsageFromApi()
      expect(acc.usedCount).toBe(70.45) // unchanged
    } finally {
      globalThis.fetch = original
    }
  })

  test('is a one-time guard (skips the second call)', async () => {
    const acc = makeAccount()
    const handler = new AuthHandler(
      { usage_tracking_enabled: true, token_expiry_buffer_ms: 300000, auto_sync_kiro_cli: false },
      fakeRepo
    )
    handler.setAccountManager(makeManager(acc))

    let calls = 0
    const original = globalThis.fetch
    globalThis.fetch = mock(async () => {
      calls++
      return new Response(CREDIT_RESPONSE, { status: 200 })
    }) as any
    try {
      await handler.refreshUsageFromApi()
      await handler.refreshUsageFromApi()
      expect(calls).toBe(1)
    } finally {
      globalThis.fetch = original
    }
  })

  test('does not release the usage-sync lock after fetching (holds it for the TTL)', async () => {
    // Must stay held so siblings within the TTL skip; releasing it 429s in turn.
    const { kiroDb } = await import('../plugin/storage/sqlite.js')
    const acc = makeAccount({ usedCount: 70.45, limitCount: 10000 })
    const handler = new AuthHandler(
      { usage_tracking_enabled: true, token_expiry_buffer_ms: 300000, auto_sync_kiro_cli: false },
      fakeRepo
    )
    handler.setAccountManager(makeManager(acc))

    const original = globalThis.fetch
    globalThis.fetch = mock(async () => new Response(CREDIT_RESPONSE, { status: 200 })) as any
    try {
      await handler.refreshUsageFromApi()
      // Lock still held: a sibling instance would find it locked and skip.
      expect(kiroDb.isUsageSyncLockHeld()).toBe(true)
    } finally {
      globalThis.fetch = original
      kiroDb.releaseUsageSyncLock()
    }
  })

  test('skips fetch silently when another instance holds the usage-sync lock', async () => {
    // Simulate another instance winning the lock for this account's TTL.
    const { kiroDb } = await import('../plugin/storage/sqlite.js')
    expect(kiroDb.acquireUsageSyncLock()).toBe(true)
    try {
      const acc = makeAccount({ usedCount: 70.45, limitCount: 10000 })
      const handler = new AuthHandler(
        { usage_tracking_enabled: true, token_expiry_buffer_ms: 300000, auto_sync_kiro_cli: false },
        fakeRepo
      )
      handler.setAccountManager(makeManager(acc))

      let calls = 0
      const original = globalThis.fetch
      globalThis.fetch = mock(async () => {
        calls++
        return new Response(CREDIT_RESPONSE, { status: 200 })
      }) as any
      // Capture warnings so we can assert no usage-fetch warning was logged
      const warnings: string[] = []
      const originalWarn = loggerMock.warn
      loggerMock.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '))
      try {
        await handler.refreshUsageFromApi()
        expect(calls).toBe(0)
        // Crucially: no "Startup usage fetch failed" warning — the lock-held
        // case must not log, because that's the whole point of the lock.
        expect(warnings.some((w) => w.includes('Startup usage fetch failed'))).toBe(false)
      } finally {
        globalThis.fetch = original
        loggerMock.warn = originalWarn
        kiroDb.releaseUsageSyncLock()
      }
    } finally {
      // Defensive: even if a test fails before releasing, clear the lock so
      // sibling tests start with a clean slate.
      kiroDb.releaseUsageSyncLock()
    }
  })
})

describe('what the sign-in form offers', () => {
  function promptsFor(config: Record<string, unknown>) {
    const handler = new AuthHandler(config as any, {} as any)
    handler.setAccountManager({} as any)
    return handler.getMethods().flatMap((m: any) => m.prompts ?? [])
  }

  test('shows the configured values, since OpenCode cannot prefill a field', () => {
    // A text prompt takes message, placeholder, validate and when — there is
    // no default. The placeholder is the only place a known value can show.
    const prompts = promptsFor({
      idc_start_url: 'https://d-996749b310.awsapps.com/start',
      idc_region: 'eu-central-1',
      idc_profile_arn: 'arn:aws:codewhisperer:eu-central-1:1:profile/AAA'
    })

    const placeholders = prompts.map((p: any) => p.placeholder)
    expect(placeholders).toContain('https://d-996749b310.awsapps.com/start')
    expect(placeholders).toContain('eu-central-1')
    expect(placeholders).toContain('arn:aws:codewhisperer:eu-central-1:1:profile/AAA')
  })

  test('falls back to an example when nothing is configured', () => {
    const prompts = promptsFor({})
    const startUrl = prompts.find((p: any) => p.key === 'start_url')
    expect(startUrl.placeholder).toBe('https://your-company.awsapps.com/start')
  })

  test('leaving a field blank is allowed when a value is already stored', () => {
    const prompts = promptsFor({
      idc_profile_arn: 'arn:aws:codewhisperer:eu-central-1:1:profile/AAA'
    })
    const arn = prompts.find((p: any) => p.key === 'profile_arn')
    expect(arn.validate('')).toBeUndefined()
  })
})
