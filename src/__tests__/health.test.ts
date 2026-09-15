import { describe, expect, test } from 'bun:test'
import { isPermanentError, isTransientNetworkError } from '../plugin/health.js'

describe('isPermanentError', () => {
  test('returns false for undefined', () => {
    expect(isPermanentError(undefined)).toBe(false)
  })

  test('returns false for empty string', () => {
    expect(isPermanentError('')).toBe(false)
  })

  test('returns false for generic error', () => {
    expect(isPermanentError('Internal Server Error')).toBe(false)
    expect(isPermanentError('Rate limited')).toBe(false)
    expect(isPermanentError('Network timeout')).toBe(false)
  })

  test('detects Invalid refresh token', () => {
    expect(isPermanentError('Invalid refresh token')).toBe(true)
    expect(isPermanentError('Error: Invalid refresh token provided')).toBe(true)
  })

  test('detects Invalid grant provided', () => {
    expect(isPermanentError('Invalid grant provided')).toBe(true)
  })

  test('detects invalid_grant', () => {
    expect(isPermanentError('invalid_grant')).toBe(true)
    expect(isPermanentError('error: invalid_grant')).toBe(true)
  })

  test('detects ExpiredTokenException', () => {
    expect(isPermanentError('ExpiredTokenException')).toBe(true)
    expect(isPermanentError('AWS: ExpiredTokenException: token expired')).toBe(true)
  })

  test('detects InvalidTokenException', () => {
    expect(isPermanentError('InvalidTokenException')).toBe(true)
  })

  test('detects ExpiredClientException', () => {
    expect(isPermanentError('ExpiredClientException')).toBe(true)
  })

  test('detects Client is expired', () => {
    expect(isPermanentError('Client is expired')).toBe(true)
  })

  test('detects HTTP_401', () => {
    expect(isPermanentError('HTTP_401')).toBe(true)
    expect(isPermanentError('error HTTP_401 Unauthorized')).toBe(true)
  })

  test('does not treat HTTP_403 as permanent (token expiry — should refresh, not reauth)', () => {
    // HTTP_403 from Kiro means the access token expired mid-request.
    // This is recoverable via token refresh, not a permanent error.
    expect(isPermanentError('HTTP_403')).toBe(false)
    expect(isPermanentError('error HTTP_403 Forbidden')).toBe(false)
  })

  test('does not treat bearer token invalid as permanent (handled in error-handler with refresh)', () => {
    // bearer token invalid triggers a forced token refresh in ErrorHandler, not permanent unhealthy.
    expect(isPermanentError('The bearer token included in the request is invalid')).toBe(false)
    expect(isPermanentError('bearer token included in the request is invalid')).toBe(false)
  })

  test('detects Account Suspended', () => {
    expect(isPermanentError('Account Suspended')).toBe(true)
  })
})

describe('what a failed token refresh tells the user', () => {
  const NETWORK = [
    'Unable to connect. Is the computer able to access the url?',
    'Was there a typo in the url or port?',
    'fetch failed',
    'ECONNRESET'
  ]

  test('a dropped link is named as one', () => {
    // Forwarded verbatim, these sent people hunting for a typo in a URL they
    // never typed, while the real state was: asleep or offline, nothing to fix.
    for (const reason of NETWORK) {
      expect(isTransientNetworkError(reason)).toBe(true)
      expect(isPermanentError(reason)).toBe(false)
    }
  })

  test('a rejected credential is not mistaken for a network blip', () => {
    // The two need opposite responses: wait and retry, or sign in again.
    for (const reason of ['invalid_grant', 'Invalid refresh token', 'expired_token']) {
      expect(isPermanentError(reason)).toBe(true)
      expect(isTransientNetworkError(reason)).toBe(false)
    }
  })
})
