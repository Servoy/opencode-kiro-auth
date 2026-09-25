import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

process.env.KIRO_DISABLE_BROWSER = '1'

let usageShouldFail = false
let saveShouldFail = false

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

// The real oauth-idc.js is exercised through a globalThis.fetch stub rather than
// mock.module. mock.module is process-global and installed at load time, so
// stubbing '../kiro/oauth-idc.js' here would leak into oauth-idc-register.test.ts
// and neuter its fetch-recording assertions whenever this file loads first —
// exactly the run-order flake that broke CI. Driving the real code via fetch
// keeps the module untouched and tests the same path production runs.
let availableProfileArns: string[] = ['arn:aws:codewhisperer:eu-central-1:123456789012:profile/ABC']
let profileLookupReachedAll = true
let profileLookupRegions: string[] = []

mock.module('../plugin/sync/kiro-cli-profile.js', () => ({
  readActiveProfileArnFromKiroCli: () => undefined
}))

const originalFetch = globalThis.fetch
const { IdcAuthMethod } = await import('../core/auth/idc-auth-method.js')

/** Region embedded in a `q.{region}.amazonaws.com` CodeWhisperer host. */
function regionFromCodeWhispererUrl(url: string): string | undefined {
  return url.match(/q\.([^.]+)\.amazonaws\.com/)?.[1]
}

/**
 * Route the real oauth-idc + usage fetches by URL and X-Amz-Target so the
 * production sign-in flow runs end to end. Device-code register/authorize/token
 * hops are answered with fixed values; ListAvailableProfiles per region and the
 * usage lookup honour the per-test flags above.
 */
function installFetchStub(): void {
  profileLookupRegions = []
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    const target = init?.headers?.['X-Amz-Target'] || ''

    if (url.endsWith('/client/register')) {
      return new Response(
        JSON.stringify({ clientId: 'client-id', clientSecret: 'client-secret' }),
        { status: 200 }
      )
    }
    if (url.endsWith('/device_authorization')) {
      return new Response(
        JSON.stringify({
          verificationUri: 'https://device.sso.eu-central-1.amazonaws.com/',
          verificationUriComplete:
            'https://device.sso.eu-central-1.amazonaws.com/?user_code=ABCD-EFGH',
          userCode: 'ABCD-EFGH',
          deviceCode: 'device-code',
          // Tiny interval keeps pollKiroIDCToken's real pre-poll sleep negligible;
          // the /token stub answers on the first attempt anyway.
          interval: 0.01,
          expiresIn: 60
        }),
        { status: 200 }
      )
    }
    if (url.endsWith('/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600
        }),
        { status: 200 }
      )
    }

    if (target.includes('ListAvailableProfiles')) {
      const region = regionFromCodeWhispererUrl(url)
      if (region) profileLookupRegions.push(region)
      // A region the lookup can't reach is a 500, which the real code counts as
      // "not reached" (reachedAll=false) rather than "no profiles granted".
      if (!profileLookupReachedAll) return new Response('unreachable', { status: 500 })
      return new Response(
        JSON.stringify({ profiles: availableProfileArns.map((arn) => ({ arn })) }),
        { status: 200 }
      )
    }

    if (usageShouldFail) {
      return new Response(
        JSON.stringify({
          __type: 'AccessDeniedException',
          message: 'The bearer token included in the request is invalid.'
        }),
        { status: 403 }
      )
    }
    return new Response(
      JSON.stringify({
        usageBreakdownList: [{ currentUsage: 5, usageLimit: 100 }],
        userInfo: { email: 'real@example.com' }
      }),
      { status: 200 }
    )
  }) as unknown as typeof fetch
}

function createMethod() {
  const savedAccounts: any[] = []
  const repository: any = {
    save: async (acc: any) => {
      if (saveShouldFail) throw new Error('DB locked')
      savedAccounts.push(acc)
    }
  }
  const accountManager: any = { addAccount: async () => {} }
  const config: any = { default_region: 'us-east-1' }
  const method = new IdcAuthMethod(config, repository, accountManager)
  return { method, savedAccounts }
}

describe('IdcAuthMethod: sign-in resilience', () => {
  beforeEach(() => {
    usageShouldFail = false
    saveShouldFail = false
    profileLookupReachedAll = true
    availableProfileArns = ['arn:aws:codewhisperer:eu-central-1:123456789012:profile/ABC']
    installFetchStub()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('succeeds when the usage lookup 403s', async () => {
    usageShouldFail = true
    const { method, savedAccounts } = createMethod()

    const result = await method.authorize({ idc_region: 'eu-central-1' })
    const outcome = await (result as any).callback()

    expect(outcome.type).toBe('success')
    expect(outcome.key).toBe('access-token')
    expect(savedAccounts).toHaveLength(1)
    expect(savedAccounts[0].isHealthy).toBe(true)
    expect(savedAccounts[0].usedCount).toBe(0)
  })

  test('resolves profileArn via ListAvailableProfiles when none is local', async () => {
    const { method, savedAccounts } = createMethod()

    const result = await method.authorize({ idc_region: 'eu-central-1' })
    await (result as any).callback()

    expect(savedAccounts[0].profileArn).toBe(
      'arn:aws:codewhisperer:eu-central-1:123456789012:profile/ABC'
    )
    expect(savedAccounts[0].region).toBe('eu-central-1')
  })

  test('succeeds even when persisting the account fails', async () => {
    saveShouldFail = true
    const { method } = createMethod()

    const result = await method.authorize({ idc_region: 'eu-central-1' })
    const outcome = await (result as any).callback()

    expect(outcome.type).toBe('success')
  })

  test('fails sign-in when the service is reachable and grants no profiles', async () => {
    availableProfileArns = []
    const { method, savedAccounts } = createMethod()

    const result = await method.authorize({ idc_region: 'eu-central-1' })
    await expect((result as any).callback()).rejects.toThrow(/no Amazon Q Developer/i)
    expect(savedAccounts).toHaveLength(0)
  })

  test('a configured ARN cannot override a conclusive "no profiles" verdict', async () => {
    availableProfileArns = []
    const { method, savedAccounts } = createMethod()

    const result = await method.authorize({
      idc_region: 'eu-central-1',
      profile_arn: 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/CONFIGURED'
    })

    await expect((result as any).callback()).rejects.toThrow(/no Amazon Q Developer/i)
    expect(savedAccounts).toHaveLength(0)
  })

  test('keeps a configured profileArn when the lookup was incomplete', async () => {
    availableProfileArns = []
    profileLookupReachedAll = false
    const { method, savedAccounts } = createMethod()

    const result = await method.authorize({
      idc_region: 'eu-central-1',
      profile_arn: 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/CONFIGURED'
    })
    const outcome = await (result as any).callback()

    expect(outcome.type).toBe('success')
    expect(savedAccounts[0].profileArn).toBe(
      'arn:aws:codewhisperer:eu-central-1:123456789012:profile/CONFIGURED'
    )
  })

  test('reports a lookup failure differently from a missing entitlement', async () => {
    availableProfileArns = []
    profileLookupReachedAll = false
    const { method } = createMethod()

    const result = await method.authorize({ idc_region: 'eu-central-1' })
    await expect((result as any).callback()).rejects.toThrow(/Could not reach CodeWhisperer/i)
  })

  test('probes the requested ARN region as well as the sign-in region', async () => {
    const { method } = createMethod()

    const result = await method.authorize({
      idc_region: 'us-east-1',
      profile_arn: 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/ABC'
    })
    await (result as any).callback()

    expect(profileLookupRegions).toContain('us-east-1')
    expect(profileLookupRegions).toContain('eu-central-1')
  })

  test('ignores a requested profileArn the service does not grant', async () => {
    availableProfileArns = ['arn:aws:codewhisperer:eu-central-1:123456789012:profile/GRANTED']
    const { method, savedAccounts } = createMethod()

    const result = await method.authorize({
      idc_region: 'eu-central-1',
      profile_arn: 'arn:aws:codewhisperer:eu-central-1:999999999999:profile/NOTMINE'
    })
    await (result as any).callback()

    expect(savedAccounts[0].profileArn).toBe(
      'arn:aws:codewhisperer:eu-central-1:123456789012:profile/GRANTED'
    )
  })
})
