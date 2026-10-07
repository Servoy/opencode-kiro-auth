import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ManagedAccount } from '../plugin/types.js'

const realLogger = await import('../plugin/logger.js')
mock.module('../plugin/logger.js', () => ({
  ...realLogger,
  debug: () => {},
  error: () => {},
  log: () => {},
  warn: () => {}
}))

const { ApiKeyAuthMethod, API_KEY_PATTERN } = await import('../core/auth/api-key-method.js')
const { KiroDatabase } = await import('../plugin/storage/sqlite.js')

const KEY_A = 'ksk_TESTKEYAAAAAAAAAAAAAAAAAAAAAAAA'
const KEY_B = 'ksk_TESTKEYBBBBBBBBBBBBBBBBBBBBBBBB'
const ARN_A = 'arn:aws:codewhisperer:eu-central-1:111111111111:profile/AAA'
const ARN_B = 'arn:aws:codewhisperer:us-east-1:222222222222:profile/BBB'
const CONFIG: any = { default_region: 'us-east-1' }
const originalFetch = globalThis.fetch

let profileStatus = 200
let usageStatus = 200
let arn = ARN_A
let email: string | undefined = 'user@example.com'
let urls: string[] = []
let bearers: string[] = []
let tokentypes: string[] = []
// Per-region GetProfile status, for the region-sweep tests. When a region has
// an entry it wins over the flat profileStatus; otherwise profileStatus applies
// so the existing single-region tests are unchanged.
let profileStatusByRegion: Record<string, number> = {}

function regionOf(url: string): string {
  return url.match(/management\.([a-z0-9-]+)\.kiro\.dev/)?.[1] ?? ''
}

function installFetch(): void {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    urls.push(url)
    bearers.push(String(init?.headers?.Authorization ?? ''))
    tokentypes.push(String(init?.headers?.tokentype ?? ''))
    const target = String(init?.headers?.['X-Amz-Target'] ?? '')

    if (url.includes('management.') && target.endsWith('.GetProfile')) {
      const status = profileStatusByRegion[regionOf(url)] ?? profileStatus
      if (status !== 200) {
        return new Response(JSON.stringify({ message: 'Invalid token' }), { status })
      }
      return new Response(JSON.stringify({ profile: { arn } }), { status: 200 })
    }
    if (url.includes('getUsageLimits')) {
      if (usageStatus !== 200) return new Response('{}', { status: usageStatus })
      return new Response(
        JSON.stringify({
          userInfo: email ? { email } : {},
          usageBreakdownList: [
            { resourceType: 'CREDIT', displayName: 'Credit', currentUsage: 12, usageLimit: 1000 }
          ]
        }),
        { status: 200 }
      )
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as unknown as typeof fetch
}

let dir: string
let db: InstanceType<typeof KiroDatabase>
let dbPath: string
let saved: ManagedAccount[]
let added: ManagedAccount[]

function makeMethod() {
  const repository: any = {
    save: async (acc: ManagedAccount) => {
      saved.push(acc)
      await db.upsertAccount(acc)
    }
  }
  const accountManager: any = {
    addAccount: async (acc: ManagedAccount) => {
      added.push(acc)
    }
  }
  return new ApiKeyAuthMethod(CONFIG, repository, accountManager)
}

// A developer (or the Servoy IDE) may have KIRO_API_KEY exported; it must not
// leak into tests that exercise the no-key / blank-input paths, or the config
// fallback would silently supply a real key. Saved and restored.
const savedEnvKey = process.env.KIRO_API_KEY

beforeEach(() => {
  delete process.env.KIRO_API_KEY
  profileStatus = 200
  profileStatusByRegion = {}
  usageStatus = 200
  arn = ARN_A
  email = 'user@example.com'
  urls = []
  bearers = []
  tokentypes = []
  saved = []
  added = []
  dir = mkdtempSync(join(tmpdir(), 'kiro-apikey-'))
  dbPath = join(dir, 'kiro.db')
  db = new KiroDatabase(dbPath)
  installFetch()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (savedEnvKey === undefined) delete process.env.KIRO_API_KEY
  else process.env.KIRO_API_KEY = savedEnvKey
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('API key sign-in', () => {
  test('saves an apikey account with the profile region and the real email', async () => {
    const result = await makeMethod().authorize({ api_key: KEY_A })

    expect(result).toEqual({ type: 'success', key: 'kiro-managed' })
    expect(saved).toHaveLength(1)
    const acc = saved[0]!
    expect(acc.authMethod).toBe('apikey')
    expect(acc.accessToken).toBe(KEY_A)
    expect(acc.expiresAt).toBe(0)
    expect(acc.profileArn).toBe(ARN_A)
    expect(acc.region).toBe('eu-central-1')
    expect(acc.email).toBe('user@example.com')
    expect(acc.usedCount).toBe(12)
    expect(acc.limitCount).toBe(1000)
    expect(acc.isHealthy).toBe(true)
    expect(added).toEqual([acc])
  })

  test('validates the key against Kiro with the key as the Bearer', async () => {
    await makeMethod().authorize({ api_key: KEY_A })

    expect(urls[0]).toContain('https://management.us-east-1.kiro.dev/')
    expect(bearers[0]).toBe(`Bearer ${KEY_A}`)
  })

  test('tells Kiro it is an API key on the profile and the usage call', async () => {
    await makeMethod().authorize({ api_key: KEY_A })

    expect(urls).toHaveLength(2)
    expect(tokentypes).toEqual(['API_KEY', 'API_KEY'])
  })

  test('trims whitespace and newlines around the pasted key', async () => {
    await makeMethod().authorize({ api_key: `  ${KEY_A}\n` })

    expect(saved[0]!.accessToken).toBe(KEY_A)
    expect(bearers[0]).toBe(`Bearer ${KEY_A}`)
  })

  test('rejects a malformed key without any network call', async () => {
    const method = makeMethod()
    for (const bad of [
      '',
      'ksk_short',
      'sk-not-a-kiro-key-000000000000000000',
      'ksk_has space 0000000000000000'
    ]) {
      const err: any = await method.authorize({ api_key: bad }).catch((e) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toBe('Enter a Kiro API key starting with ksk_')
    }
    expect(await method.authorize().catch((e) => e)).toBeInstanceOf(Error)
    expect(urls).toHaveLength(0)
    expect(saved).toHaveLength(0)
  })

  test('falls back to another Kiro region when the preferred one rejects the key', async () => {
    // The Servoy case: default_region (us-east-1) is the wrong host for an
    // eu-central-1 key, so GetProfile there rejects; the sweep then tries
    // eu-central-1, which answers with the ARN. Only KIRO_API_KEY needs setting.
    profileStatusByRegion = { 'us-east-1': 400, 'eu-central-1': 200 }
    arn = ARN_A // eu-central-1 ARN

    const result = await makeMethod().authorize({ api_key: KEY_A })

    expect(result.type).toBe('success')
    expect(saved).toHaveLength(1)
    expect(saved[0]!.region).toBe('eu-central-1')
    // Preferred region tried first, then the fallback.
    const profileRegions = urls.filter((u) => u.includes('management.')).map(regionOf)
    expect(profileRegions[0]).toBe('us-east-1')
    expect(profileRegions).toContain('eu-central-1')
  })

  test('a key rejected by every region fails with the rejection, not a transport error', async () => {
    profileStatusByRegion = { 'us-east-1': 403, 'eu-central-1': 403 }
    const err: any = await makeMethod()
      .authorize({ api_key: KEY_A })
      .catch((e) => e)

    expect(String(err.message)).toContain('rejected')
    expect(String(err.message)).not.toContain(KEY_A)
    expect(saved).toHaveLength(0)
  })

  test('a 403 from GetProfile persists nothing and the error does not contain the key', async () => {
    profileStatus = 403
    const err: any = await makeMethod()
      .authorize({ api_key: KEY_A })
      .catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect(String(err.message)).toContain('rejected')
    expect(String(err.message)).not.toContain(KEY_A)
    expect(saved).toHaveLength(0)
    expect(added).toHaveLength(0)
    expect(db.getAccounts()).toHaveLength(0)
  })

  test('a 400 Invalid token from GetProfile is a rejection too', async () => {
    profileStatus = 400
    const err: any = await makeMethod()
      .authorize({ api_key: KEY_A })
      .catch((e) => e)

    expect(String(err.message)).toContain('rejected')
    expect(saved).toHaveLength(0)
  })

  test('a 5xx from GetProfile persists nothing and says validation failed', async () => {
    profileStatus = 503
    const err: any = await makeMethod()
      .authorize({ api_key: KEY_A })
      .catch((e) => e)

    expect(String(err.message)).toContain('Could not validate')
    expect(String(err.message)).toContain('503')
    expect(saved).toHaveLength(0)
  })

  test('a 200 without a profile arn persists nothing', async () => {
    arn = ''
    const err: any = await makeMethod()
      .authorize({ api_key: KEY_A })
      .catch((e) => e)

    expect(String(err.message)).toContain('no profile')
    expect(saved).toHaveLength(0)
  })

  test('a network failure persists nothing and does not leak the key', async () => {
    globalThis.fetch = (async () => {
      throw new Error(`fetch failed for Bearer ${KEY_A}`)
    }) as unknown as typeof fetch
    const err: any = await makeMethod()
      .authorize({ api_key: KEY_A })
      .catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect(String(err.message)).toContain('Could not reach Kiro')
    expect(String(err.message)).not.toContain(KEY_A)
    expect(saved).toHaveLength(0)
  })

  test('a usage lookup failure still signs in with zeroed usage', async () => {
    usageStatus = 500
    await makeMethod().authorize({ api_key: KEY_A })

    expect(saved).toHaveLength(1)
    expect(saved[0]!.usedCount).toBe(0)
    expect(saved[0]!.limitCount).toBe(0)
  })

  test('without a real email the account gets a stable placeholder, never the key', async () => {
    email = undefined
    await makeMethod().authorize({ api_key: KEY_A })
    const first = saved[0]!
    await makeMethod().authorize({ api_key: KEY_A })
    const second = saved[1]!

    expect(first.email).toMatch(/^apikey-placeholder\+[0-9a-f]{16}@awsapps\.local$/)
    expect(second.email).toBe(first.email)
    expect(second.id).toBe(first.id)
  })

  test('the account never stores the raw key in refresh_token, id or email', async () => {
    email = undefined
    await makeMethod().authorize({ api_key: KEY_A })
    const acc = saved[0]!

    expect(acc.refreshToken).toMatch(/^apikey:[0-9a-f]{16}$/)
    expect(
      JSON.stringify({ id: acc.id, email: acc.email, refresh: acc.refreshToken })
    ).not.toContain(KEY_A)
  })

  test('pasting the same key twice leaves one row', async () => {
    const method = makeMethod()
    await method.authorize({ api_key: KEY_A })
    await method.authorize({ api_key: KEY_A })

    expect(db.getAccounts()).toHaveLength(1)
  })

  test('a blank prompt falls back to KIRO_API_KEY from the environment', async () => {
    process.env.KIRO_API_KEY = KEY_A
    await makeMethod().authorize({ api_key: '' })

    expect(saved).toHaveLength(1)
    expect(saved[0]!.accessToken).toBe(KEY_A)
  })

  test('no inputs at all (the auto-register call) uses the configured key', async () => {
    const method = new ApiKeyAuthMethod({ default_region: 'us-east-1', api_key: KEY_A }, {
      save: async (acc: ManagedAccount) => {
        saved.push(acc)
        await db.upsertAccount(acc)
      }
    } as any)
    await method.authorize()

    expect(saved).toHaveLength(1)
    expect(saved[0]!.accessToken).toBe(KEY_A)
  })

  test('a typed malformed key is rejected even when a valid key is configured', async () => {
    // The configured key must never silently stand in for a wrong paste.
    process.env.KIRO_API_KEY = KEY_A
    const err: any = await makeMethod()
      .authorize({ api_key: 'ksk_short' })
      .catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect(saved).toHaveLength(0)
    expect(urls).toHaveLength(0)
  })

  test('pasting a new key for the same profile replaces the old one and recovers a dead account', async () => {
    await makeMethod().authorize({ api_key: KEY_A })
    await db.upsertAccount({
      ...saved[0]!,
      isHealthy: false,
      failCount: 10,
      unhealthyReason: 'unauthorized: API key rejected by Kiro'
    })
    expect((db.getAccounts()[0] as any).is_healthy).toBe(0)

    await makeMethod().authorize({ api_key: KEY_B })

    const rows = db.getAccounts() as any[]
    expect(rows).toHaveLength(1)
    expect(rows[0].access_token).toBe(KEY_B)
    expect(rows[0].is_healthy).toBe(1)
    expect(rows[0].unhealthy_reason).toBeNull()
    expect(rows[0].fail_count).toBe(0)
  })

  test('two apikey accounts with different emails survive reopening the database', async () => {
    const method = makeMethod()
    await method.authorize({ api_key: KEY_A })
    arn = ARN_B
    email = 'other@example.com'
    await method.authorize({ api_key: KEY_B })
    expect(db.getAccounts()).toHaveLength(2)

    db.close()
    db = new KiroDatabase(dbPath)

    const rows = db.getAccounts() as any[]
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.access_token).sort()).toEqual([KEY_A, KEY_B].sort())
  })
})

describe('the key shape', () => {
  test('accepts the documented shape and rejects look-alikes', () => {
    expect(API_KEY_PATTERN.test('ksk_0123456789abcdefghijklmnopqrstuv')).toBe(true)
    expect(API_KEY_PATTERN.test('ksk_0123456789abcdef')).toBe(true)
    expect(API_KEY_PATTERN.test('ksk_short')).toBe(false)
    expect(API_KEY_PATTERN.test('KSK_0123456789abcdefghijklmnopqrstuv')).toBe(false)
    expect(API_KEY_PATTERN.test('xksk_0123456789abcdefghijklmnopqrstuv')).toBe(false)
    expect(API_KEY_PATTERN.test('ksk_0123456789abcdef ghij')).toBe(false)
  })
})
