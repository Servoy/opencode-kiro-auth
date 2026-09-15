import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findOpencodeInstallDir, pickConfigDir } from '../plugin/config/paths.js'

const WIN = '\\'

describe('config dir: finding the opencode install', () => {
  test('finds the relocated data dir a distribution installs into', () => {
    const modulePath = [
      'C:',
      'Users',
      'someone',
      '.servoy',
      'opencode',
      'packages',
      'https_',
      'github.com',
      'Servoy',
      'opencode-kiro-auth',
      'node_modules',
      '@servoy',
      'opencode-kiro-auth',
      'dist'
    ].join(WIN)

    expect(findOpencodeInstallDir(modulePath, WIN)).toBe(
      ['C:', 'Users', 'someone', '.servoy', 'opencode'].join(WIN)
    )
  })

  test('finds the standard install too', () => {
    expect(
      findOpencodeInstallDir(
        '/home/someone/.config/opencode/node_modules/@servoy/opencode-kiro-auth/dist',
        '/'
      )
    ).toBe('/home/someone/.config/opencode')
  })

  test('does not mistake a package named opencode-something for the install dir', () => {
    expect(
      findOpencodeInstallDir('/work/opencode-kiro-auth/src/plugin/config', '/')
    ).toBeUndefined()
  })
})

describe('config dir: which directory wins', () => {
  const platformDir = '/home/someone/.config/opencode'
  const installDir = '/home/someone/.servoy/opencode'

  test('prefers a config that already exists next to the install', () => {
    const dir = pickConfigDir(installDir, platformDir, (d) => d === installDir)
    expect(dir).toBe(installDir)
  })

  test('keeps using an existing platform config when the install has none', () => {
    const dir = pickConfigDir(installDir, platformDir, (d) => d === platformDir)
    expect(dir).toBe(platformDir)
  })

  test('provisions next to the install when neither exists', () => {
    const dir = pickConfigDir(installDir, platformDir, () => false)
    expect(dir).toBe(installDir)
  })

  test('falls back to the platform dir when there is no install dir', () => {
    const dir = pickConfigDir(undefined, platformDir, () => false)
    expect(dir).toBe(platformDir)
  })
})

describe('the config file lists every setting', () => {
  test('DEFAULT_CONFIG covers every schema field that has a default', async () => {
    // A setting missing here never reaches the user's file, so it is real,
    // documented nowhere, and only findable by reading the source.
    const { DEFAULT_CONFIG, KiroConfigSchema } = await import('../plugin/config/schema.js')
    const parsed = KiroConfigSchema.parse({})

    for (const key of Object.keys(parsed)) {
      expect(DEFAULT_CONFIG).toHaveProperty(key)
    }
  })

  test('every default is documented in the README', async () => {
    const { DEFAULT_CONFIG } = await import('../plugin/config/schema.js')
    const readme = readFileSync(join(import.meta.dir, '..', '..', 'README.md'), 'utf-8')

    for (const key of Object.keys(DEFAULT_CONFIG)) {
      expect(readme).toContain(`\`${key}\``)
    }
  })

  test('the README example is the defaults, exactly', async () => {
    // Checking only that a name appears somewhere let a removed setting sit in
    // the example block, which is the part people copy.
    const { DEFAULT_CONFIG } = await import('../plugin/config/schema.js')
    const readme = readFileSync(join(import.meta.dir, '..', '..', 'README.md'), 'utf-8')
    const block = readme.match(/```json\n(\{\n  "account_selection_strategy"[\s\S]*?)\n```/)

    expect(block).not.toBeNull()
    expect(JSON.parse(block![1]!)).toEqual(DEFAULT_CONFIG)
  })
})

describe('tidying a config file that has drifted', () => {
  test('a retired setting is dropped, not left pretending to work', async () => {
    const { RETIRED_SETTINGS, DEFAULT_CONFIG } = await import('../plugin/config/schema.js')
    for (const key of RETIRED_SETTINGS) {
      expect(DEFAULT_CONFIG).not.toHaveProperty(key)
    }
    expect(RETIRED_SETTINGS).toContain('auth_server_port_start')
    expect(RETIRED_SETTINGS).toContain('prompt_caching')
  })

  test('a retired name is never reused for a live setting', async () => {
    // Re-adding one under its old name would silently delete a user's value.
    const { RETIRED_SETTINGS, KiroConfigSchema } = await import('../plugin/config/schema.js')
    const live = Object.keys(KiroConfigSchema.shape)
    for (const key of RETIRED_SETTINGS) {
      expect(live).not.toContain(key)
    }
  })
})
