import { describe, expect, test } from 'bun:test'
import { buildWebSearchToolV2, WEB_SEARCH_DESCRIPTION } from '../plugin/web-search.js'

describe('v2 web search tool', () => {
  test('WEB_SEARCH_DESCRIPTION is non-empty', () => {
    expect(WEB_SEARCH_DESCRIPTION).toBeTruthy()
    expect(typeof WEB_SEARCH_DESCRIPTION).toBe('string')
  })

  test('buildWebSearchToolV2 returns a tool info when an account is available', () => {
    const accountManager = {
      getCurrentOrNext: () => ({ profileArn: 'arn:aws:codewhisperer:eu-central-1:123:profile/X' })
    } as never
    const tool = buildWebSearchToolV2(accountManager)
    expect(tool).not.toBeNull()
    expect(tool?.name).toBe('kiro_web_search')
    expect(tool?.description).toBe(WEB_SEARCH_DESCRIPTION)
    expect(typeof tool?.execute).toBe('function')
  })

  test('buildWebSearchToolV2 returns null when no account has a profileArn', () => {
    const accountManager = {
      getCurrentOrNext: () => ({ profileArn: undefined })
    } as never
    const tool = buildWebSearchToolV2(accountManager)
    expect(tool).toBeNull()
  })

  test('buildWebSearchToolV2 returns null when no accounts exist', () => {
    const accountManager = {
      getCurrentOrNext: () => null
    } as never
    const tool = buildWebSearchToolV2(accountManager)
    expect(tool).toBeNull()
  })

  test('execute resolves to a Tool.Result ({ content }), never throws', async () => {
    const accountManager = {
      getCurrentOrNext: () => ({ profileArn: 'arn:aws:codewhisperer:eu-central-1:123:profile/X' })
    } as never
    const tool = buildWebSearchToolV2(accountManager)
    expect(tool).not.toBeNull()
    const out = await tool!.execute({ query: '' } as never, {
      signal: new AbortController().signal
    })
    expect(typeof out).toBe('object')
    expect(typeof out.content).toBe('string')
  })
})
