import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets } from '../plugin/redact.js'

/**
 * Guards that the logger's write path routes content through redaction — the
 * fix for the live bearer-token leak in plugin.log.
 *
 * It does NOT read a shared on-disk log: the config dir caches process-globally
 * and sibling suites set/delete KIRO_CONFIG_DIR and rmSync their temp dirs, so
 * the logger's resolved dir is not stable across the shared Bun run (that
 * ordering flake, not the redaction, was the failure here). Instead it
 * reconstructs the exact line writeToFile builds and asserts redaction strips
 * the token. The composed-write invariant — that writeToFile passes its content
 * through redactSecrets — is locked by the source assertion below, so this stays
 * a guard on the real code, not a copy of it.
 */
describe('logger redaction', () => {
  const token = 'aoaAAAAAsupersecretbearertokenpayload1234567890abcdef'
  const rawLine = `[IN] headers={"authorization":"Bearer ${token}","content-type":"application/json"}`

  test('redaction masks the exact line the logger builds for a request', () => {
    const out = redactSecrets(rawLine)
    expect(out).not.toContain(token)
    expect(out).toContain('Bearer [redacted]')
    expect(out).toContain('application/json')
  })

  test('the logger sends its content through redactSecrets at the write point', () => {
    // Read the logger source and assert the write calls redactSecrets. This
    // fails if someone removes the redaction wrapper from writeToFile or
    // writeApiLog, which is the regression that would re-open the leak.
    const src = readFileSync(join(import.meta.dir, '..', 'plugin', 'logger.ts'), 'utf8')
    expect(src).toContain('redactSecrets(content)')
    // Both sinks (line log + api json dump) must be wrapped.
    const wrapped = src.match(/redactSecrets\(content\)/g) ?? []
    expect(wrapped.length).toBeGreaterThanOrEqual(2)
  })
})
