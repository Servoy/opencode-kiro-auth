import { afterEach, describe, expect, mock, test } from 'bun:test'

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
  // Pinned: a "bearer token invalid" 403 was chased to this shape and it was
  // not the cause. Changing it needs a reproduction, not a theory.
  test('registers the shape that is known to produce a working token', async () => {
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
    expect(register?.body).toEqual({
      clientName: 'Kiro IDE',
      clientType: 'public',
      scopes: [
        'codewhisperer:completions',
        'codewhisperer:analysis',
        'codewhisperer:conversations',
        'codewhisperer:transformations',
        'codewhisperer:taskassist'
      ],
      grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token']
    })
  })

  test('passes the org start URL to the device authorization', async () => {
    const calls = stubFetch((url) => {
      if (url.endsWith('/client/register')) {
        return new Response(JSON.stringify({ clientId: 'cid', clientSecret: 'secret' }), {
          status: 200
        })
      }
      return deviceAuthResponse()
    })

    await authorizeKiroIDC('eu-central-1', 'https://d-996749b310.awsapps.com/start')

    const deviceAuth = calls.find((c) => c.url.endsWith('/device_authorization'))
    expect(deviceAuth?.body.startUrl).toBe('https://d-996749b310.awsapps.com/start')
  })

  test('surfaces a registration failure instead of continuing', async () => {
    stubFetch((url) =>
      url.endsWith('/client/register')
        ? new Response('boom', { status: 500 })
        : deviceAuthResponse()
    )

    await expect(
      authorizeKiroIDC('eu-central-1', 'https://example.awsapps.com/start')
    ).rejects.toThrow(/Client registration failed: 500/)
  })
})

describe('profile lookup across regions', () => {
  test('aggregates profiles found in any probed region', async () => {
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
