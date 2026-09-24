import { describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KiroDatabase } from '../plugin/storage/sqlite.js'

mock.module('../plugin/logger.js', () => ({
  debug: () => {},
  error: () => {},
  log: () => {},
  warn: () => {},
  setDebugEnabled: () => {},
  getTimestamp: () => '2026-07-22T00:00:00.000Z',
  logApiError: () => {},
  logApiRequest: () => {},
  logApiResponse: () => {}
}))

const US_PROFILE = 'arn:aws:codewhisperer:us-east-1:123456789012:profile/ABC'

function cliDatabase(
  registrationRegion: string | undefined,
  sessionRegion: string | undefined
): string {
  const dir = mkdtempSync(join(tmpdir(), 'kiro-cli-region-'))
  const path = join(dir, 'data.sqlite3')
  const db = new KiroDatabase(path) as any
  const raw = (db as any).db

  raw.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  raw.exec('CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  raw.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?)').run(
    'kirocli:odic:device-registration',
    JSON.stringify({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      ...(registrationRegion ? { region: registrationRegion } : {})
    })
  )
  raw.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?)').run(
    'kirocli:odic:token',
    JSON.stringify({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      profile_arn: US_PROFILE,
      ...(sessionRegion ? { region: sessionRegion } : {})
    })
  )
  db.close()
  return path
}

async function syncedAccount(registrationRegion?: string, sessionRegion?: string) {
  const cliPath = cliDatabase(registrationRegion, sessionRegion)
  const configDir = mkdtempSync(join(tmpdir(), 'kiro-region-cfg-'))

  process.env.KIROCLI_DB_PATH = cliPath
  process.env.KIRO_CONFIG_DIR = configDir
  try {
    const { syncFromKiroCli } = await import('../plugin/sync/kiro-cli.js')
    const { kiroDb } = await import('../plugin/storage/sqlite.js')
    await syncFromKiroCli()
    // kiroDb is shared across the suite, so match our row by ARN, not by index.
    return kiroDb.getAccounts().find((a) => a.profile_arn === US_PROFILE)
  } finally {
    delete process.env.KIROCLI_DB_PATH
    delete process.env.KIRO_CONFIG_DIR
    rmSync(configDir, { recursive: true, force: true })
  }
}

describe('which region can refresh the token', () => {
  test('the region that issued the device registration wins over the profile ARN', async () => {
    // Distinct regions on purpose: only then does a pass prove the registration
    // region wins over the session region, not that they happened to agree.
    const account = await syncedAccount('ap-southeast-1', 'eu-west-1')

    expect(account?.oidc_region).toBe('ap-southeast-1')
    expect(account?.region).toBe('us-east-1')
  })

  test('the session region is used when the registration does not name one', async () => {
    const account = await syncedAccount(undefined, 'eu-central-1')

    expect(account?.oidc_region).toBe('eu-central-1')
  })

  test('falls back to the profile region when neither names one', async () => {
    const account = await syncedAccount(undefined, undefined)

    expect(account?.oidc_region).toBe('us-east-1')
  })

  test('a nonsense region is ignored rather than substituted', async () => {
    const account = await syncedAccount('not-a-region', undefined)

    expect(account?.oidc_region).toBe('us-east-1')
  })
})
