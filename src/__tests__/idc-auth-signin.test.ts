import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

process.env.KIRO_DISABLE_BROWSER = '1'

let usageShouldFail = false
let saveShouldFail = false

mock.module('../plugin/logger.js', () => ({
  debug: () => {},
  error: () => {},
  log: () => {},
  warn: () => {},
  getTimestamp: () => '2026-07-22T00:00:00.000Z'
}))

mock.module('../kiro/oauth-idc.js', () => ({
  authorizeKiroIDC: async () => ({
    userCode: 'ABCD-EFGH',
    deviceCode: 'device-code',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    interval: 1,
    expiresIn: 60,
    verificationUrl: 'https://device.sso.eu-central-1.amazonaws.com/',
    verificationUriComplete: 'https://device.sso.eu-central-1.amazonaws.com/?user_code=ABCD-EFGH'
  }),
  pollKiroIDCToken: async () => ({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 3_600_000,
    clientId: 'client-id',
    clientSecret: 'client-secret'
  }),
  listAvailableProfileArns: async () => [
    'arn:aws:codewhisperer:eu-central-1:123456789012:profile/ABC'
  ]
}))

mock.module('../plugin/sync/kiro-cli-profile.js', () => ({
  readActiveProfileArnFromKiroCli: () => undefined
}))

const originalFetch = globalThis.fetch
const { IdcAuthMethod } = await import('../core/auth/idc-auth-method.js')

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
    globalThis.fetch = (async (input: any, init?: any) => {
      const target = init?.headers?.['X-Amz-Target'] || ''
      if (target.includes('ListAvailableProfiles')) {
        return new Response(
          JSON.stringify({
            profiles: [{ arn: 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/ABC' }]
          }),
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
})
