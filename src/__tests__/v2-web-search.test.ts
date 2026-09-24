import { describe, expect, test } from 'bun:test'
import { buildWebSearchProviderV2, WEB_SEARCH_DESCRIPTION } from '../plugin/web-search.js'

describe('v2 web search provider', () => {
  test('WEB_SEARCH_DESCRIPTION is non-empty', () => {
    expect(WEB_SEARCH_DESCRIPTION).toBeTruthy()
    expect(typeof WEB_SEARCH_DESCRIPTION).toBe('string')
  })

  test('buildWebSearchProviderV2 returns a provider (id/name/execute) for a Pro account', () => {
    const accountManager = {
      getCurrentOrNext: () => ({ profileArn: 'arn:aws:codewhisperer:eu-central-1:123:profile/X' })
    } as never
    const provider = buildWebSearchProviderV2(accountManager)
    expect(provider).not.toBeNull()
    expect(provider?.id).toBe('kiro')
    expect(provider?.name).toBe('Kiro')
    expect(typeof provider?.execute).toBe('function')
  })

  test('buildWebSearchProviderV2 returns null without a Pro profileArn', () => {
    const accountManager = { getCurrentOrNext: () => ({ profileArn: undefined }) } as never
    expect(buildWebSearchProviderV2(accountManager)).toBeNull()
  })

  test('execute maps Kiro results to the host WebSearch.Result shape', async () => {
    // The provider must translate our snippet/publishedDate to the host's
    // content/time.published, or the results render blank in OpenCode.
    const accountManager = {
      getCurrentOrNext: () => ({
        profileArn: 'arn:aws:codewhisperer:eu-central-1:123:profile/X',
        region: 'eu-central-1',
        accessToken: 'a',
        refreshToken: 'r',
        expiresAt: Date.now() + 3_600_000,
        email: 'user@servoy.com'
      }),
      toAuthDetails: (a: any) => ({
        access: a.accessToken,
        refresh: a.refreshToken,
        expires: a.expiresAt,
        region: a.region,
        profileArn: a.profileArn,
        email: a.email
      }),
      updateFromAuth: async () => {}
    } as never

    const provider = buildWebSearchProviderV2(accountManager)!
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  results: [
                    {
                      title: 'T',
                      url: 'https://x.test',
                      snippet: 'S',
                      domain: 'x.test',
                      publishedDate: 1234
                    }
                  ]
                })
              }
            ]
          }
        }),
        { status: 200 }
      )) as never
    try {
      const out = await provider.execute({ query: 'hi' }, { signal: new AbortController().signal })
      expect(out).toHaveLength(1)
      expect(out[0]).toEqual({
        url: 'https://x.test',
        title: 'T',
        content: 'S',
        time: { published: 1234 }
      })
    } finally {
      globalThis.fetch = original
    }
  })
})
