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
})
