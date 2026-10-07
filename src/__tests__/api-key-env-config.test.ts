import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { configuredApiKey, maskApiKey } from '../core/auth/api-key-method.js'

const KEY = 'ksk_TESTKEYAAAAAAAAAAAAAAAAAAAA1234'
const savedEnv = process.env.KIRO_API_KEY

beforeEach(() => {
  delete process.env.KIRO_API_KEY
})
afterEach(() => {
  if (savedEnv === undefined) delete process.env.KIRO_API_KEY
  else process.env.KIRO_API_KEY = savedEnv
})

describe('configuredApiKey', () => {
  test('env wins over kiro.json', () => {
    process.env.KIRO_API_KEY = KEY
    expect(configuredApiKey({ api_key: 'ksk_fromconfig0000000000000000' })).toBe(KEY)
  })

  test('falls back to kiro.json when env is unset', () => {
    expect(configuredApiKey({ api_key: 'ksk_fromconfig0000000000000000' })).toBe(
      'ksk_fromconfig0000000000000000'
    )
  })

  test('trims surrounding whitespace (a pasted newline must not survive)', () => {
    process.env.KIRO_API_KEY = `  ${KEY}\n`
    expect(configuredApiKey({})).toBe(KEY)
  })

  test('a blank or whitespace-only value is unset', () => {
    process.env.KIRO_API_KEY = '   '
    expect(configuredApiKey({ api_key: '  ' })).toBeUndefined()
    expect(configuredApiKey({})).toBeUndefined()
  })
})

describe('maskApiKey', () => {
  test('shows only the ksk_ prefix and the last four, never the whole key', () => {
    const masked = maskApiKey(KEY)
    expect(masked).toBe('ksk_…1234')
    expect(masked).not.toContain(KEY)
    expect(KEY).not.toContain(masked) // the mask is not a substring of the real key
  })
})
