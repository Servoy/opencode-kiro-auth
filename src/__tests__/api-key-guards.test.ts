import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accessTokenExpired, decodeRefreshToken, encodeRefreshToken } from '../kiro/auth.js'
import { KiroTokenRefreshError } from '../plugin/errors.js'
import { isPermanentError } from '../plugin/health.js'
import type { KiroAuthDetails } from '../plugin/types.js'

const realLogger = await import('../plugin/logger.js')
mock.module('../plugin/logger.js', () => ({
  ...realLogger,
  debug: () => {},
  error: () => {},
  log: () => {},
  warn: () => {}
}))

const { refreshAccessToken } = await import('../plugin/token.js')
const { TokenRefresher } = await import('../core/auth/token-refresher.js')
const { writeToKiroCli } = await import('../plugin/sync/kiro-cli.js')
const { AccountManager } = await import('../plugin/accounts.js')
const { RequestHandler } = await import('../core/request/request-handler.js')
const { IdcAuthMethod } = await import('../core/auth/idc-auth-method.js')
const { openDatabase } = await import('../plugin/storage/database-driver.js')

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function countFetches(): { calls: number } {
  const state = { calls: 0 }
  globalThis.fetch = (async () => {
    state.calls++
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
  return state
}

function keyAuth(overrides: Partial<KiroAuthDetails> = {}): KiroAuthDetails {
  return {
    refresh: 'apikey:0123456789abcdef|apikey',
    access: 'ksk_TESTKEY000000000000000000000000',
    expires: 0,
    authMethod: 'apikey',
    region: 'us-east-1',
    ...overrides
  }
}

describe('apikey credentials', () => {
  test('round-trips the apikey tag through encode and decode', () => {
    const encoded = encodeRefreshToken({
      refreshToken: 'apikey:0123456789abcdef',
      authMethod: 'apikey'
    })
    expect(encoded).toBe('apikey:0123456789abcdef|apikey')
    expect(decodeRefreshToken(encoded)).toEqual({
      refreshToken: 'apikey:0123456789abcdef',
      authMethod: 'apikey'
    })
  })

  test('an apikey with expires 0 is never expired', () => {
    expect(accessTokenExpired(keyAuth())).toBe(false)
    expect(accessTokenExpired(keyAuth(), 10 * 365 * 24 * 3600 * 1000)).toBe(false)
  })

  test('an apikey with no access token counts as expired', () => {
    expect(accessTokenExpired(keyAuth({ access: '' }))).toBe(true)
  })

  test('an idc token with expires 0 is still expired', () => {
    expect(accessTokenExpired(keyAuth({ authMethod: 'idc', refresh: 'r|c|s|idc' }))).toBe(true)
  })
})

function makeRefresher() {
  const account: any = {
    id: 'k1',
    email: 'key@example.com',
    authMethod: 'apikey',
    region: 'us-east-1',
    refreshToken: 'apikey:0123456789abcdef',
    accessToken: 'ksk_TESTKEY000000000000000000000000',
    expiresAt: 0,
    isHealthy: true,
    failCount: 0
  }
  const unhealthy: string[] = []
  const counts = { sync: 0, updateFromAuth: 0 }
  const accountManager: any = {
    markUnhealthy: async (_a: any, reason: string) => {
      unhealthy.push(reason)
    },
    updateFromAuth: async () => {
      counts.updateFromAuth++
    },
    toAuthDetails: (a: any) => ({
      access: a.accessToken,
      refresh: `${a.refreshToken}|apikey`,
      expires: a.expiresAt,
      authMethod: a.authMethod,
      region: a.region,
      email: a.email
    })
  }
  const repository: any = { invalidateCache: () => {}, findAll: async () => [account] }
  const config = {
    token_expiry_buffer_ms: 0,
    auto_sync_kiro_cli: true,
    account_selection_strategy: 'sticky' as const
  }
  const refresher = new TokenRefresher(
    config,
    accountManager,
    async () => {
      counts.sync++
    },
    repository
  )
  return { refresher, account, accountManager, unhealthy, counts }
}

describe('apikey refresh paths', () => {
  test('refreshAccessToken rejects an apikey before any network call', async () => {
    const net = countFetches()
    const err: any = await refreshAccessToken(keyAuth()).catch((e) => e)
    expect(net.calls).toBe(0)
    expect(err).toBeInstanceOf(KiroTokenRefreshError)
    expect(err.code).toBe('API_KEY_NOT_REFRESHABLE')
    expect(isPermanentError(err.message)).toBe(true)
  })

  test('forceRefresh on an apikey account marks it permanently unhealthy without network or CLI sync', async () => {
    const net = countFetches()
    const { refresher, account, accountManager, unhealthy, counts } = makeRefresher()

    const ok = await refresher.forceRefresh(account, accountManager.toAuthDetails(account))

    expect(ok).toBe(false)
    expect(net.calls).toBe(0)
    expect(counts.sync).toBe(0)
    expect(counts.updateFromAuth).toBe(0)
    expect(unhealthy).toHaveLength(1)
    expect(isPermanentError(unhealthy[0])).toBe(true)
  })

  test('refreshIfNeeded leaves an apikey account alone', async () => {
    const net = countFetches()
    const { refresher, account, accountManager } = makeRefresher()

    const out = await refresher.refreshIfNeeded(
      account,
      accountManager.toAuthDetails(account),
      () => {}
    )

    expect(out).toEqual({ account, shouldContinue: false })
    expect(net.calls).toBe(0)
  })
})

describe('the Kiro CLI database', () => {
  const SOCIAL = 'kirocli:social:token'
  const ORIGINAL = JSON.stringify({
    access_token: 'cli-access',
    refresh_token: 'cli-refresh',
    expires_at: '2030-01-01T00:00:00.000Z'
  })

  function withCliDb(run: (path: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'kiro-cli-'))
    const path = join(dir, 'data.sqlite3')
    const db = openDatabase(path)
    db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)')
    db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?)').run(SOCIAL, ORIGINAL)
    db.close()
    const previous = process.env.KIROCLI_DB_PATH
    process.env.KIROCLI_DB_PATH = path
    return run(path).finally(() => {
      if (previous === undefined) delete process.env.KIROCLI_DB_PATH
      else process.env.KIROCLI_DB_PATH = previous
      rmSync(dir, { recursive: true, force: true })
    })
  }

  function readSocial(path: string): string {
    const db = openDatabase(path, { readonly: true })
    const row = db.prepare('SELECT value FROM auth_kv WHERE key = ?').get(SOCIAL) as any
    db.close()
    return row.value
  }

  const account = (authMethod: 'apikey' | 'desktop') => ({
    authMethod,
    accessToken: 'ksk_TESTKEY000000000000000000000000',
    refreshToken: 'written-refresh',
    expiresAt: 0
  })

  test('writeToKiroCli leaves the CLI social token untouched for an apikey account', () =>
    withCliDb(async (path) => {
      await writeToKiroCli(account('apikey'))
      expect(readSocial(path)).toBe(ORIGINAL)
    }))

  test('writeToKiroCli still updates the social token for a desktop account', () =>
    withCliDb(async (path) => {
      await writeToKiroCli({ ...account('desktop'), expiresAt: Date.now() + 3_600_000 })
      expect(JSON.parse(readSocial(path)).refresh_token).toBe('written-refresh')
    }))
})

describe('apikey recovery and re-auth', () => {
  const ARN = 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/ABC'

  const keyAccount = (): any => ({
    id: 'key-1',
    email: 'key@example.com',
    authMethod: 'apikey',
    region: 'us-east-1',
    refreshToken: 'apikey:0123456789abcdef',
    accessToken: 'ksk_TESTKEY000000000000000000000000',
    expiresAt: 0,
    rateLimitResetTime: 0,
    isHealthy: false,
    failCount: 10,
    unhealthyReason: 'unauthorized: API key rejected by Kiro'
  })

  const idcAccount = (): any => ({
    id: 'idc-1',
    email: 'idc@example.com',
    authMethod: 'idc',
    region: 'eu-central-1',
    oidcRegion: 'eu-central-1',
    profileArn: ARN,
    startUrl: 'https://corp.awsapps.com/start',
    refreshToken: 'r',
    accessToken: 'a',
    expiresAt: Date.now() - 1000,
    rateLimitResetTime: 0,
    isHealthy: false,
    failCount: 10,
    unhealthyReason: 'invalid_grant'
  })

  function makeHandler(accounts: any[]) {
    const accountManager: any = {
      getAccounts: () => accounts,
      getAccountCount: () => accounts.length,
      toAuthDetails: (a: any) => ({
        access: a.accessToken,
        refresh: a.refreshToken,
        expires: a.expiresAt,
        authMethod: a.authMethod,
        region: a.region
      })
    }
    const repository: any = {
      invalidateCache: () => {},
      findAll: async () => accounts
    }
    const config: any = {
      max_request_iterations: 5,
      request_timeout_ms: 5_000,
      token_expiry_buffer_ms: 0,
      auto_sync_kiro_cli: false,
      account_selection_strategy: 'sticky'
    }
    const toasts: Array<{ message: string; variant: string }> = []
    const toast = (message: string, variant: string) => toasts.push({ message, variant })
    const handler: any = new RequestHandler(accountManager, config, repository, {})
    return { handler, toast, toasts }
  }

  const authorizeInputs: Array<Record<string, string>> = []
  const spies: Array<{ mockRestore: () => void }> = []
  const idcSpy = () => {
    const spy = spyOn(IdcAuthMethod.prototype, 'authorize').mockImplementation((async (
      inputs: any
    ) => {
      authorizeInputs.push({ ...inputs })
      throw new Error('stop before any browser flow')
    }) as any)
    spies.push(spy)
    return spy
  }

  afterEach(() => {
    authorizeInputs.length = 0
    while (spies.length) spies.pop()!.mockRestore()
  })

  test('catalog recovery gives up quietly for an apikey account', async () => {
    const { handler } = makeHandler([keyAccount()])
    let forced = 0
    handler.tokenRefresher = {
      forceRefresh: async () => {
        forced++
        return true
      }
    }

    expect(await handler.recoverAuthForCatalog(keyAccount())).toBeUndefined()
    expect(forced).toBe(0)
  })

  test('reauth with only apikey accounts never starts the IdC flow', async () => {
    const spy = idcSpy()
    const net = countFetches()
    const { handler, toast, toasts } = makeHandler([keyAccount()])

    expect(await handler.triggerReauth(toast)).toBe(false)

    expect(spy).not.toHaveBeenCalled()
    expect(net.calls).toBe(0)
    expect(toasts.some((t) => t.variant === 'error')).toBe(true)
  })

  test('reauth with a mixed pool prefills from the idc account', async () => {
    const spy = idcSpy()
    const { handler, toast } = makeHandler([keyAccount(), idcAccount()])

    await handler.performReauth(toast)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(authorizeInputs[0]).toEqual({
      profile_arn: ARN,
      start_url: 'https://corp.awsapps.com/start',
      idc_region: 'eu-central-1'
    })
  })

  test('an idc-only pool still starts the IdC flow', async () => {
    const spy = idcSpy()
    const { handler, toast } = makeHandler([idcAccount()])

    expect(await handler.triggerReauth(toast)).toBe(false)

    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('a rejected key next to other accounts', () => {
  const key = (): any => ({
    id: 'key-1',
    email: 'key@example.com',
    authMethod: 'apikey',
    region: 'us-east-1',
    profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/KEY',
    refreshToken: 'apikey:0123456789abcdef',
    accessToken: 'ksk_TESTKEY000000000000000000000000',
    expiresAt: 0,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    lastUsed: 0
  })

  const idc = (): any => ({
    id: 'idc-1',
    email: 'idc@example.com',
    authMethod: 'idc',
    region: 'eu-central-1',
    profileArn: 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/IDC',
    refreshToken: 'r',
    accessToken: 'a',
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    lastUsed: 0
  })

  function refresherFor(manager: any) {
    const repository: any = { invalidateCache: () => {}, findAll: async () => [] }
    const config = {
      token_expiry_buffer_ms: 0,
      auto_sync_kiro_cli: false,
      account_selection_strategy: 'sticky' as const
    }
    return new TokenRefresher(config, manager, async () => {}, repository)
  }

  test('requests move to the identity center account', async () => {
    const rejected = key()
    const fallback = idc()
    const manager = new AccountManager([rejected, fallback], 'sticky')
    expect(manager.getCurrentOrNext()).toBe(rejected)

    const ok = await refresherFor(manager).forceRefresh(rejected, manager.toAuthDetails(rejected))

    expect(ok).toBe(false)
    expect(manager.getCurrentOrNext()).toBe(fallback)
  })

  test('with only keys left there is no account to select', async () => {
    const rejected = key()
    const manager = new AccountManager([rejected], 'sticky')

    await refresherFor(manager).forceRefresh(rejected, manager.toAuthDetails(rejected))

    expect(manager.getCurrentOrNext()).toBeNull()
  })
})
