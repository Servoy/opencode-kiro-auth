import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrapAuthIfNeeded, hasApiKey } from '../plugin/auth-bootstrap.js'

const originalHome = process.env.HOME
const originalXdgDataHome = process.env.XDG_DATA_HOME
const originalKiroCliDbPath = process.env.KIROCLI_DB_PATH
const originalApiKey = process.env.KIRO_API_KEY

// A developer with KIRO_API_KEY exported would otherwise make the "no API key"
// cases see a real key and flip their result. Clear before each; restore after.
beforeEach(() => {
  delete process.env.KIRO_API_KEY
})

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome

  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalXdgDataHome

  if (originalKiroCliDbPath === undefined) delete process.env.KIROCLI_DB_PATH
  else process.env.KIROCLI_DB_PATH = originalKiroCliDbPath

  if (originalApiKey === undefined) delete process.env.KIRO_API_KEY
  else process.env.KIRO_API_KEY = originalApiKey
})

function setupBootstrapFixture() {
  const home = mkdtempSync(join(tmpdir(), 'kiro-auth-bootstrap-'))
  process.env.HOME = home
  process.env.XDG_DATA_HOME = join(home, '.local', 'share')

  const cliDbPath = join(home, 'kiro-cli.sqlite3')
  writeFileSync(cliDbPath, '')
  process.env.KIROCLI_DB_PATH = cliDbPath

  const authDir = join(home, '.local', 'share', 'opencode')
  const authPath = join(authDir, 'auth.json')
  mkdirSync(authDir, { recursive: true })

  return { home, authPath }
}

/** A home with NO Kiro CLI DB — the API-key-only / Servoy-IDE case. */
function setupNoCliDbFixture() {
  const home = mkdtempSync(join(tmpdir(), 'kiro-auth-nocli-'))
  process.env.HOME = home
  process.env.XDG_DATA_HOME = join(home, '.local', 'share')
  process.env.KIROCLI_DB_PATH = join(home, 'does-not-exist.sqlite3')

  const authDir = join(home, '.local', 'share', 'opencode')
  const authPath = join(authDir, 'auth.json')
  mkdirSync(authDir, { recursive: true })

  return { home, authPath }
}

describe('bootstrapAuthIfNeeded', () => {
  test('does not rewrite malformed auth.json', () => {
    const { home, authPath } = setupBootstrapFixture()
    writeFileSync(authPath, '{"github":')

    bootstrapAuthIfNeeded('kiro')

    expect(readFileSync(authPath, 'utf-8')).toBe('{"github":')
    rmSync(home, { recursive: true, force: true })
  })

  test('adds placeholder while preserving existing auth providers', () => {
    const { home, authPath } = setupBootstrapFixture()
    writeFileSync(authPath, JSON.stringify({ github: { type: 'api', key: 'existing' } }, null, 2))

    bootstrapAuthIfNeeded('kiro')

    expect(JSON.parse(readFileSync(authPath, 'utf-8'))).toEqual({
      github: { type: 'api', key: 'existing' },
      kiro: { type: 'api', key: 'kiro-bootstrap-placeholder' }
    })
    rmSync(home, { recursive: true, force: true })
  })

  test('preserves restrictive auth.json permissions when rewriting', () => {
    const { home, authPath } = setupBootstrapFixture()
    writeFileSync(authPath, JSON.stringify({ github: { type: 'api', key: 'existing' } }, null, 2))
    chmodSync(authPath, 0o600)

    bootstrapAuthIfNeeded('kiro')

    expect(statSync(authPath).mode & 0o777).toBe(0o600)
    rmSync(home, { recursive: true, force: true })
  })

  test('no CLI DB and no API key: skips, leaving auth.json untouched', () => {
    const { home, authPath } = setupNoCliDbFixture()
    writeFileSync(authPath, JSON.stringify({ github: { type: 'api', key: 'existing' } }, null, 2))

    bootstrapAuthIfNeeded('kiro')

    expect(JSON.parse(readFileSync(authPath, 'utf-8'))).toEqual({
      github: { type: 'api', key: 'existing' }
    })
    rmSync(home, { recursive: true, force: true })
  })

  test('no CLI DB but KIRO_API_KEY set: writes the placeholder so the loader runs', () => {
    // The headless / Servoy-IDE case: no kiro-cli, only an env key. Without this
    // trigger the loader never runs and the provider never comes up.
    const { home, authPath } = setupNoCliDbFixture()
    process.env.KIRO_API_KEY = 'ksk_TESTKEY000000000000000000000000'
    writeFileSync(authPath, JSON.stringify({ github: { type: 'api', key: 'existing' } }, null, 2))

    bootstrapAuthIfNeeded('kiro')

    expect(JSON.parse(readFileSync(authPath, 'utf-8'))).toEqual({
      github: { type: 'api', key: 'existing' },
      kiro: { type: 'api', key: 'kiro-bootstrap-placeholder' }
    })
    rmSync(home, { recursive: true, force: true })
  })
})

describe('hasApiKey', () => {
  const savedConfigDir = process.env.KIRO_CONFIG_DIR
  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.KIRO_CONFIG_DIR
    else process.env.KIRO_CONFIG_DIR = savedConfigDir
  })

  test('true when KIRO_API_KEY is set, whatever the config file holds', () => {
    process.env.KIRO_API_KEY = 'ksk_env'
    expect(hasApiKey('/no/such/kiro.json')).toBe(true)
  })

  test('reads api_key from the given kiro.json when env is unset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiro-haskey-'))
    const path = join(dir, 'kiro.json')
    writeFileSync(path, JSON.stringify({ api_key: 'ksk_fromconfig' }))
    expect(hasApiKey(path)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test('false when neither env nor config has a usable key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiro-haskey-'))
    const path = join(dir, 'kiro.json')
    writeFileSync(path, JSON.stringify({ api_key: '   ' })) // whitespace-only is unset
    expect(hasApiKey(path)).toBe(false)
    expect(hasApiKey(join(dir, 'absent.json'))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})
