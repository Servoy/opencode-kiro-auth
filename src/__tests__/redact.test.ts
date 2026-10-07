import { describe, expect, test } from 'bun:test'
import { redactSecrets } from '../plugin/redact.js'

describe('redactSecrets', () => {
  test('masks a Kiro bearer token but keeps the scheme and a short tail', () => {
    const raw =
      'headers={"authorization":"Bearer aoaAAAAAGqCzdAuzBsVpfhGnaOQtz8MraYB3Sjjf2PFMfC3spRcgnEXxP8X2TFqfyjM11fNodOs1YmDuGXTzoP"}'
    const out = redactSecrets(raw)
    expect(out).not.toContain(
      'aoaAAAAAGqCzdAuzBsVpfhGnaOQtz8MraYB3Sjjf2PFMfC3spRcgnEXxP8X2TFqfyjM11fNodOs1YmDuGXTzoP'
    )
    expect(out).toContain('Bearer ')
    expect(out).toContain('[redacted]')
  })

  test('masks a case-insensitive Authorization header value', () => {
    const raw = '{"Authorization":"Bearer sk-verysecrettokenvalue1234567890"}'
    const out = redactSecrets(raw)
    expect(out).not.toContain('sk-verysecrettokenvalue1234567890')
    expect(out).toContain('[redacted]')
  })

  test('masks Basic and token schemes too', () => {
    expect(redactSecrets('authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ1Njc4')).not.toContain(
      'dXNlcjpwYXNzd29yZDEyMzQ1Njc4'
    )
    expect(
      redactSecrets('authorization: token ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    ).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  })

  test('masks a raw bearer token embedded in a longer string without an authorization key', () => {
    const raw = 'x-amz-token=Bearer aoaZZZZsecrettokenpayloadthatislongenough1234567890'
    const out = redactSecrets(raw)
    expect(out).not.toContain('aoaZZZZsecrettokenpayloadthatislongenough1234567890')
  })

  test('leaves ordinary text and short values untouched', () => {
    const raw = 'model=auto stream=true history=422 entries convId=64a6e919'
    expect(redactSecrets(raw)).toBe(raw)
  })

  test('redacts inside a plain object via the JSON string it is logged as', () => {
    const line = JSON.stringify({
      authorization: 'Bearer aoaAAAAAlongsecrettokenpayload1234567890abcdefghij',
      model: 'auto'
    })
    const out = redactSecrets(line)
    expect(out).not.toContain('aoaAAAAAlongsecrettokenpayload1234567890abcdefghij')
    expect(out).toContain('"model":"auto"')
  })

  describe('a Kiro API key', () => {
    const KEY = 'ksk_TESTKEY000000000000000000000000'

    test('masks a bare key', () => {
      const out = redactSecrets(`signing in with ${KEY} now`)
      expect(out).not.toContain(KEY)
      expect(out).toContain('[redacted]')
    })

    test('masks a key in key=value form', () => {
      expect(redactSecrets(`api_key=${KEY}`)).not.toContain(KEY)
      expect(redactSecrets(`{"key":"${KEY}"}`)).not.toContain(KEY)
    })

    test('masks a key after Bearer', () => {
      expect(redactSecrets(`authorization: Bearer ${KEY}`)).not.toContain(KEY)
    })

    test('masks a key with no word boundary before it', () => {
      // The gap a leading \b leaves: when the char before `ksk_` is itself a
      // word char there is no boundary, so `\bksk_` would not fire. The key must
      // be caught wherever it appears, boundary or not.
      const out = redactSecrets(`anoiseprefix${KEY}`)
      expect(out).not.toContain(KEY)
    })

    test('masks a truncated key below the 16-char validation floor', () => {
      // A sliced key in a log is still a live secret; the redactor floor sits
      // below the validation floor on purpose so a fragment is masked too.
      const fragment = 'ksk_TESTKEY00000000' // ksk_ + 14 chars
      expect(redactSecrets(`leaked ${fragment} here`)).not.toContain(fragment)
    })

    test('leaves the bare marker and too-short runs untouched', () => {
      // `ksk_` alone, or with <8 body chars, is not a key and stays readable.
      const raw = 'prefix ksk_ and ksk_abc are not keys'
      expect(redactSecrets(raw)).toBe(raw)
    })
  })
})
