import { afterEach, describe, expect, mock, test } from 'bun:test'
import { resolveAccountRegion } from '../constants.js'

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

const EU_ARN = 'arn:aws:codewhisperer:eu-central-1:428597928572:profile/HE7XVERQ9VXW'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

/** Records the host every call goes to, so routing can be asserted directly. */
function captureHosts(body: unknown, status = 200): string[] {
  const hosts: string[] = []
  globalThis.fetch = (async (input: any) => {
    hosts.push(new URL(typeof input === 'string' ? input : input.url).host)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  }) as unknown as typeof fetch
  return hosts
}

describe('resolveAccountRegion', () => {
  test('the profile ARN decides, even when the recorded region disagrees', () => {
    // The ARN is where the account's data actually lives; `region` is only
    // what the sign-in happened to write down.
    expect(resolveAccountRegion({ region: 'us-east-1', profileArn: EU_ARN })).toBe('eu-central-1')
  })

  test('falls back to the recorded region when there is no ARN', () => {
    expect(resolveAccountRegion({ region: 'eu-central-1' })).toBe('eu-central-1')
  })

  test('ignores a region that is not a region', () => {
    expect(resolveAccountRegion({ region: 'not-a-region' as never })).toBe('us-east-1')
  })

  test('reports the last-resort fallback rather than taking it quietly', () => {
    const reasons: string[] = []
    expect(resolveAccountRegion({ region: undefined as never }, (r) => reasons.push(r))).toBe(
      'us-east-1'
    )
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('us-east-1')
  })

  test('says nothing when it did not have to fall back', () => {
    const reasons: string[] = []
    resolveAccountRegion({ region: 'us-east-1', profileArn: EU_ARN }, (r) => reasons.push(r))
    expect(reasons).toEqual([])
  })
})

describe('where an account’s calls actually land', () => {
  // The account that exposed this: an EU profile whose stored region still
  // said us-east-1. Inference followed the ARN while the catalog and the usage
  // lookup followed the region, so one account's traffic was split across two
  // jurisdictions with nothing reporting it.
  const auth: any = {
    access: 'a',
    refresh: 'r|desktop',
    expires: 0,
    authMethod: 'desktop',
    region: 'us-east-1',
    profileArn: EU_ARN
  }

  test('the model catalog follows the ARN, not the recorded region', async () => {
    const { refreshModelCatalog, resetModelCatalog, getCatalogCapabilities } =
      await import('../plugin/models.js')
    resetModelCatalog()
    const hosts = captureHosts({
      models: [{ modelId: 'claude-haiku-4.5', tokenLimits: { maxInputTokens: 200000 } }]
    })

    await refreshModelCatalog(auth)

    expect(hosts).toEqual(['management.eu-central-1.kiro.dev'])
    expect(getCatalogCapabilities('claude-haiku-4-5')).toBeDefined()
    resetModelCatalog()
  })

  test('the usage lookup follows the ARN too', async () => {
    const { fetchUsageLimits } = await import('../plugin/usage.js')
    const hosts = captureHosts({ usageBreakdownList: [], userInfo: { email: 'x@y.z' } })

    await fetchUsageLimits(auth)

    expect(hosts[0]).toBe('q.eu-central-1.amazonaws.com')
  })

  test('inference goes to the same region', async () => {
    const { resolveKiroEndpoint } = await import('../plugin/sdk-client.js')
    expect(new URL(resolveKiroEndpoint(auth)).host).toBe('runtime.eu-central-1.kiro.dev')
  })

  test('every call for one account lands in the same region', async () => {
    // The invariant the split broke. A free Builder ID account has no ARN, so
    // both shapes have to hold.
    const { resolveKiroEndpoint } = await import('../plugin/sdk-client.js')
    const { refreshModelCatalog, resetModelCatalog } = await import('../plugin/models.js')
    const { fetchUsageLimits } = await import('../plugin/usage.js')

    for (const account of [
      auth,
      { ...auth, profileArn: undefined, region: 'eu-central-1' },
      { ...auth, profileArn: undefined, region: 'us-east-1' }
    ]) {
      resetModelCatalog()
      const hosts = captureHosts({
        models: [{ modelId: 'claude-haiku-4.5', tokenLimits: { maxInputTokens: 200000 } }],
        usageBreakdownList: [],
        userInfo: { email: 'x@y.z' }
      })
      await refreshModelCatalog(account)
      await fetchUsageLimits(account)
      hosts.push(new URL(resolveKiroEndpoint(account)).host)

      const regions = new Set(hosts.map((h) => h.split('.')[1]))
      expect({ account: account.profileArn ?? account.region, regions: [...regions] }).toEqual({
        account: account.profileArn ?? account.region,
        regions: [resolveAccountRegion(account)]
      })
    }
    resetModelCatalog()
  })
})

describe('the desktop refresh endpoint', () => {
  test('is us-east-1 whatever region the account is in', async () => {
    // Only prod.us-east-1 has a DNS record; the Kiro CLI hardcodes it. Filling
    // in the account's region sent every desktop account outside us-east-1 to
    // a host that does not resolve, so its token could never be refreshed.
    const { refreshAccessToken } = await import('../plugin/token.js')
    const hosts = captureHosts({ accessToken: 'new', refreshToken: 'r2', expiresIn: 3600 })

    await refreshAccessToken({
      access: 'a',
      refresh: 'r|desktop',
      expires: 0,
      authMethod: 'desktop',
      region: 'eu-central-1'
    } as never).catch(() => {})

    expect(hosts).toEqual(['prod.us-east-1.auth.desktop.kiro.dev'])
  })

  test('an IDC refresh still goes to the region that registered the device', async () => {
    const { refreshAccessToken } = await import('../plugin/token.js')
    const hosts = captureHosts({ accessToken: 'new', refreshToken: 'r2', expiresIn: 3600 })

    await refreshAccessToken({
      access: 'a',
      refresh: 'r|cid|secret|idc',
      expires: 0,
      authMethod: 'idc',
      region: 'us-east-1',
      oidcRegion: 'eu-central-1'
    } as never).catch(() => {})

    expect(hosts).toEqual(['oidc.eu-central-1.amazonaws.com'])
  })
})
