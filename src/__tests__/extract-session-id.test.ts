import { describe, expect, test } from 'bun:test'
import { extractSessionId } from '../core/request/request-handler.js'

// The conversation key falls back to hashing the first user message when no
// session id is found, so two sessions in one directory would collide. These
// pin the three header names OpenCode has shipped for the id, and their order.
describe('extractSessionId', () => {
  test('reads x-session-id first', () => {
    expect(
      extractSessionId({
        'x-session-id': 'ses_A',
        'x-session-affinity': 'ses_B',
        'x-opencode-session': 'ses_C'
      })
    ).toBe('ses_A')
  })

  test('falls back to x-session-affinity when x-session-id is absent', () => {
    expect(extractSessionId({ 'x-session-affinity': 'ses_B', 'x-opencode-session': 'ses_C' })).toBe(
      'ses_B'
    )
  })

  test('falls back to x-opencode-session, the v2 trace header, when the others are absent', () => {
    // The regression case: a host that drops the older two but keeps the trace
    // header must still yield a session id, not fall through to the hash.
    expect(extractSessionId({ 'x-opencode-session': 'ses_C' })).toBe('ses_C')
  })

  test('returns undefined when no session header is present', () => {
    expect(extractSessionId({ 'content-type': 'application/json' })).toBeUndefined()
  })

  test('returns undefined for missing headers', () => {
    expect(extractSessionId(undefined)).toBeUndefined()
    expect(extractSessionId(null)).toBeUndefined()
  })
})
