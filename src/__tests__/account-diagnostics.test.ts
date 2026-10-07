import { describe, expect, mock, test } from 'bun:test'
import type { ManagedAccount } from '../plugin/types'

const logs: Array<{ level: 'log' | 'warn'; message: string }> = []

mock.module('../plugin/logger.js', () => ({
  log: (message: string) => logs.push({ level: 'log', message }),
  warn: (message: string) => logs.push({ level: 'warn', message }),
  debug: () => {},
  error: () => {},
  setDebugEnabled: () => {},
  getTimestamp: () => '2026-10-07T00:00:00.000Z',
  logApiError: () => {},
  logApiRequest: () => {},
  logApiResponse: () => {}
}))

const { logAccountDiagnostics, warnIfProviderWillNotRegister } =
  await import('../plugin/account-diagnostics.js')
const { getConfigDir } = await import('../plugin/config/paths.js')
const { getCliDbPath } = await import('../plugin/sync/kiro-cli-parser.js')

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

describe('logAccountDiagnostics', () => {
  test('empty store warns, naming the kiro.db that was read', () => {
    logs.length = 0
    logAccountDiagnostics([], true)
    const warn = logs.find((l) => l.level === 'warn')
    expect(warn).toBeDefined()
    expect(warn!.message).toContain(`${getConfigDir()}/kiro.db`)
  })

  test('empty store with auto-sync off points at the fix, not the kiro-cli db', () => {
    logs.length = 0
    logAccountDiagnostics([], false)
    const warn = logs.find((l) => l.level === 'warn')!
    expect(warn.message).toContain('auto_sync_kiro_cli: true')
    expect(warn.message).not.toContain(getCliDbPath())
  })

  test('empty store with auto-sync on names the kiro-cli db it expects a sync from', () => {
    logs.length = 0
    logAccountDiagnostics([], true)
    const warn = logs.find((l) => l.level === 'warn')!
    expect(warn.message).toContain(getCliDbPath())
  })

  test('loaded accounts report the usable count, no warning', () => {
    logs.length = 0
    logAccountDiagnostics([acc(), acc({ id: 'b' })], true)
    const line = logs.find((l) => l.level === 'log')!
    expect(line.message).toContain('2 loaded (2 usable)')
    expect(logs.some((l) => l.level === 'warn')).toBe(false)
  })

  test('accounts present but none usable warns distinctly from an empty store', () => {
    logs.length = 0
    // Expired-token permanent error: loaded but unusable.
    logAccountDiagnostics(
      [acc({ isHealthy: false, unhealthyReason: 'ExpiredTokenException' })],
      true
    )
    const warn = logs.find((l) => l.level === 'warn')!
    expect(warn.message).toContain('unusable')
    expect(warn.message).not.toContain('No Kiro accounts')
  })
})

describe('warnIfProviderWillNotRegister', () => {
  test('warns on the split-store dead end: account present, host connection absent', () => {
    logs.length = 0
    warnIfProviderWillNotRegister(true, false)
    const warn = logs.find((l) => l.level === 'warn')!
    expect(warn).toBeDefined()
    expect(warn.message).toContain('will not register')
    expect(warn.message).toContain('not available in your country')
  })

  test('silent when the host already holds the credential', () => {
    logs.length = 0
    warnIfProviderWillNotRegister(true, true)
    expect(logs).toHaveLength(0)
  })

  test('silent when there is no usable account to register anyway', () => {
    logs.length = 0
    warnIfProviderWillNotRegister(false, false)
    expect(logs).toHaveLength(0)
  })
})
