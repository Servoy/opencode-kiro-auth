import { afterEach, describe, expect, mock, test } from 'bun:test'
import { KIRO_AUTH_SERVICE } from '../constants.js'

mock.module('../plugin/logger.js', () => ({
  debug: () => {},
  error: () => {},
  log: () => {},
  warn: () => {},
  getTimestamp: () => '2026-07-22T00:00:00.000Z'
}))

const { authorizeKiroIDC, listAvailableProfileArnsAcrossRegions } =
  await import('../kiro/oauth-idc.js')

const originalFetch = globalThis.fetch

interface Recorded {
  url: string
  body: any
}

function stubFetch(handler: (url: string, body: any) => Response): Recorded[] {
  const calls: Recorded[] = []
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    const body = init?.body ? JSON.parse(init.body) : {}
    calls.push({ url, body })
    return handler(url, body)
  }) as unknown as typeof fetch
  return calls
}

function deviceAuthResponse(): Response {
  return new Response(
    JSON.stringify({
      verificationUri: 'https://example.awsapps.com/start/#/device',
      verificationUriComplete: 'https://example.awsapps.com/start/#/device?user_code=ABCD',
      userCode: 'ABCD-EFGH',
      deviceCode: 'device-code',
      interval: 1,
      expiresIn: 600
    }),
    { status: 200 }
  )
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('IDC client registration', () => {
  test('requests only the scopes the Q Developer application actually grants', () => {
    // Asking for transformations/taskassist on an Identity Center instance that
    // does not grant them yields a token the service rejects on every call with
    // "the bearer token included in the request is invalid" — while sign-in
    // itself still reports success.
    expect(KIRO_AUTH_SERVICE.SCOPES).toEqual([
      'codewhisperer:completions',
      'codewhisperer:analysis',
      'codewhisperer:conversations'
    ])
  })

  test('binds the client to the Identity Center instance via issuerUrl', async () => {
    const calls = stubFetch((url) => {
      if (url.endsWith('/client/register')) {
        return new Response(JSON.stringify({ clientId: 'cid', clientSecret: 'secret' }), {
          status: 200
        })
      }
      return deviceAuthResponse()
    })

    await authorizeKiroIDC('eu-central-1', 'https://d-996749b310.awsapps.com/start')

    const register = calls.find((c) => c.url.endsWith('/client/register'))
    expect(register?.body.issuerUrl).toBe('https://d-996749b310.awsapps.com/start')
    expect(register?.body.scopes).toEqual(KIRO_AUTH_SERVICE.SCOPES)
  })

  test('omits issuerUrl for Builder ID, which has no Identity Center instance', async () => {
    const calls = stubFetch((url) => {
      if (url.endsWith('/client/register')) {
        return new Response(JSON.stringify({ clientId: 'cid', clientSecret: 'secret' }), {
          status: 200
        })
      }
      return deviceAuthResponse()
    })

    await authorizeKiroIDC('us-east-1', KIRO_AUTH_SERVICE.BUILDER_ID_START_URL)

    const register = calls.find((c) => c.url.endsWith('/client/register'))
    expect(register?.body.issuerUrl).toBeUndefined()
  })

  test('falls back to a plain registration when issuerUrl is rejected', async () => {
    let registerAttempts = 0
    const calls = stubFetch((url) => {
      if (url.endsWith('/client/register')) {
        registerAttempts++
        if (registerAttempts === 1) {
          return new Response(
            JSON.stringify({ error: 'invalid_client_metadata', error_description: 'issuerUrl' }),
            { status: 400 }
          )
        }
        return new Response(JSON.stringify({ clientId: 'cid', clientSecret: 'secret' }), {
          status: 200
        })
      }
      return deviceAuthResponse()
    })

    const auth = await authorizeKiroIDC('eu-central-1', 'https://example.awsapps.com/start')

    expect(registerAttempts).toBe(2)
    expect(auth.clientId).toBe('cid')
    const second = calls.filter((c) => c.url.endsWith('/client/register'))[1]
    expect(second?.body.issuerUrl).toBeUndefined()
  })

  test('does not retry registration on a server error', async () => {
    let registerAttempts = 0
    stubFetch((url) => {
      if (url.endsWith('/client/register')) {
        registerAttempts++
        return new Response('boom', { status: 500 })
      }
      return deviceAuthResponse()
    })

    await expect(
      authorizeKiroIDC('eu-central-1', 'https://example.awsapps.com/start')
    ).rejects.toThrow(/Client registration failed: 500/)
    expect(registerAttempts).toBe(1)
  })
})

describe('profile lookup across regions', () => {
  test('aggregates profiles found in any probed region', async () => {
    // Profiles are regional. Probing only the sign-in region made a
    // correctly-entitled user in another region look like "no profile".
    stubFetch((url) => {
      if (url.includes('eu-central-1')) {
        return new Response(
          JSON.stringify({
            profiles: [{ arn: 'arn:aws:codewhisperer:eu-central-1:1:profile/EU' }]
          }),
          { status: 200 }
        )
      }
      return new Response(JSON.stringify({ profiles: [] }), { status: 200 })
    })

    const { arns, reachedAll } = await listAvailableProfileArnsAcrossRegions('token', ['us-east-1'])

    expect(arns).toEqual(['arn:aws:codewhisperer:eu-central-1:1:profile/EU'])
    expect(reachedAll).toBe(true)
  })

  test('an empty answer from every region is a conclusive answer', async () => {
    stubFetch(() => new Response(JSON.stringify({ profiles: [] }), { status: 200 }))

    const { arns, reachedAll, reachedAny } = await listAvailableProfileArnsAcrossRegions('token', [
      'eu-central-1'
    ])

    expect(arns).toEqual([])
    expect(reachedAll).toBe(true)
    expect(reachedAny).toBe(true)
  })

  test('one unreachable region makes an empty result inconclusive', async () => {
    stubFetch((url) =>
      url.includes('us-east-1')
        ? new Response('nope', { status: 500 })
        : new Response(JSON.stringify({ profiles: [] }), { status: 200 })
    )

    const { arns, reachedAll, reachedAny } = await listAvailableProfileArnsAcrossRegions('token', [
      'eu-central-1'
    ])

    expect(arns).toEqual([])
    expect(reachedAll).toBe(false)
    expect(reachedAny).toBe(true)
  })

  test('reports nothing reached when every region errors', async () => {
    stubFetch(() => new Response('nope', { status: 403 }))

    const { arns, reachedAll, reachedAny } = await listAvailableProfileArnsAcrossRegions('token', [
      'eu-central-1'
    ])

    expect(arns).toEqual([])
    expect(reachedAll).toBe(false)
    expect(reachedAny).toBe(false)
  })
})
