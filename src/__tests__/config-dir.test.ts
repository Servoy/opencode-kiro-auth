import { describe, expect, test } from 'bun:test'
import { findOpencodeInstallDir, pickConfigDir } from '../plugin/config/paths.js'

const WIN = '\\'

describe('config dir: finding the opencode install', () => {
  test('finds the relocated data dir a distribution installs into', () => {
    // The Servoy build runs opencode out of ~/.servoy/opencode, so its
    // provisioned kiro.json lives there — not in %APPDATA%\opencode.
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
    // Previously this always landed in the platform dir, so a distribution's
    // own kiro.json (start url, region, profile arn) was silently ignored and
    // the plugin ran on bare defaults.
    const dir = pickConfigDir(installDir, platformDir, () => false)
    expect(dir).toBe(installDir)
  })

  test('falls back to the platform dir when there is no install dir', () => {
    const dir = pickConfigDir(undefined, platformDir, () => false)
    expect(dir).toBe(platformDir)
  })
})
