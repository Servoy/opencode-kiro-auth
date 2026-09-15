import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LOADER = join(import.meta.dir, '..', 'plugin', 'config', 'loader.ts')

/**
 * Every project on this machine loads its own copy of the plugin and they all
 * start at once, so the top-up is a read-modify-write that several processes
 * reach together. Twenty-six of them, which is what a real desktop looks like.
 */
test('concurrent starts leave one valid file with every default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiro-race-'))
  const path = join(dir, 'kiro.json')
  writeFileSync(
    path,
    JSON.stringify(
      {
        default_region: 'eu-central-1',
        trace: true,
        auth_server_port_start: 19847,
        my_own_note: 'keep me'
      },
      null,
      2
    )
  )

  const script = join(dir, 'start.ts')
  writeFileSync(
    script,
    [
      `const { loadConfig } = await import(${JSON.stringify(LOADER)})`,
      `loadConfig(${JSON.stringify(dir)})`
    ].join('\n')
  )

  const runs = Array.from({ length: 26 }, () =>
    Bun.spawn(['bun', 'run', script], {
      env: { ...process.env, KIRO_CONFIG_DIR: dir, NODE_ENV: 'production' },
      stdout: 'ignore',
      stderr: 'ignore'
    })
  )
  await Promise.all(runs.map((r) => r.exited))

  const parsed = JSON.parse(readFileSync(path, 'utf-8'))
  expect(parsed.default_region).toBe('eu-central-1')
  expect(parsed.trace).toBe(true)
  expect(parsed.max_payload_bytes).toBeDefined()
  expect(parsed.image_carry_forward).toBeDefined()
  // Retired settings go; anything we do not recognise is the user's, and stays.
  expect(parsed).not.toHaveProperty('auth_server_port_start')
  expect(parsed.my_own_note).toBe('keep me')
}, 60_000)
