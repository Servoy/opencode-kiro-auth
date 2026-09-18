import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolvePlatformCacheDir, resolvePlatformConfigDir } from '../plugin/config/paths.js'

describe('config dir: state and log share one directory', () => {
  test('kiro.json and plugin.log both sit under getConfigDir', async () => {
    // The bug this locks out: plugin.log resolving somewhere other than the
    // config, so it lands where nobody looks. State the plugin owns derives
    // from the same dir.
    const { getConfigDir } = await import('../plugin/config/paths.js')
    const dir = getConfigDir()

    const { getUserConfigPath } = await import('../plugin/config/loader.js')
    expect(getUserConfigPath()).toBe(join(dir, 'kiro.json'))

    // The log dir is the config dir, with no separate override to drift from.
    const paths = await import('../plugin/config/paths.js')
    expect('getDefaultLogsDir' in paths).toBe(false)
    expect(process.env.KIRO_LOG_DIR).toBeUndefined()
  })

  test('getConfigDir is stable once resolved', async () => {
    const { getConfigDir } = await import('../plugin/config/paths.js')
    expect(getConfigDir()).toBe(getConfigDir())
  })
})

describe('cache dir: regenerable data lives apart from state', () => {
  test('getCacheDir is a separate, stable directory from getConfigDir', async () => {
    const { getConfigDir, getCacheDir } = await import('../plugin/config/paths.js')
    // Disposable cache must not land next to credentials/state.
    expect(getCacheDir()).not.toBe(getConfigDir())
    expect(getCacheDir()).toBe(getCacheDir())
  })
})

describe('resolveDir precedence', () => {
  test('an explicit override wins over test mode and platform default', async () => {
    const { resolveDir } = await import('../plugin/config/paths.js')
    expect(
      resolveDir({
        override: '/explicit/here',
        isTest: true,
        testDirName: 'x',
        platformDir: () => '/platform'
      })
    ).toBe('/explicit/here')
  })

  test('test mode uses an isolated dir under tmp, never the platform default', async () => {
    const { resolveDir } = await import('../plugin/config/paths.js')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    let platformCalled = false
    const dir = resolveDir({
      override: undefined,
      isTest: true,
      testDirName: 'kiro-x',
      platformDir: () => {
        platformCalled = true
        return '/platform'
      }
    })
    expect(dir).toBe(join(tmpdir(), 'kiro-x'))
    // The platform default must not even be consulted — that is what keeps the
    // suite off the developer's real kiro.db and plugin.log.
    expect(platformCalled).toBe(false)
  })

  test('with no override outside test mode, the platform default is used', async () => {
    const { resolveDir } = await import('../plugin/config/paths.js')
    expect(
      resolveDir({
        override: undefined,
        isTest: false,
        testDirName: 'x',
        platformDir: () => '/platform/opencode'
      })
    ).toBe('/platform/opencode')
  })
})

describe('platform config dir: state location per OS', () => {
  const HOME_NIX = '/home/alice'
  const HOME_WIN = 'C:\\Users\\alice'

  test('Windows uses %APPDATA%\\opencode (Roaming)', () => {
    expect(
      resolvePlatformConfigDir({
        platform: 'win32',
        home: HOME_WIN,
        env: { APPDATA: 'C:\\Users\\alice\\AppData\\Roaming' }
      })
    ).toBe('C:\\Users\\alice\\AppData\\Roaming\\opencode')
  })

  test('Windows falls back to ~/AppData/Roaming when APPDATA is unset', () => {
    expect(resolvePlatformConfigDir({ platform: 'win32', home: HOME_WIN, env: {} })).toBe(
      'C:\\Users\\alice\\AppData\\Roaming\\opencode'
    )
  })

  test('macOS uses ~/.config/opencode (XDG-style, matching OpenCode itself)', () => {
    expect(resolvePlatformConfigDir({ platform: 'darwin', home: HOME_NIX, env: {} })).toBe(
      '/home/alice/.config/opencode'
    )
  })

  test('Linux honours XDG_CONFIG_HOME', () => {
    expect(
      resolvePlatformConfigDir({
        platform: 'linux',
        home: HOME_NIX,
        env: { XDG_CONFIG_HOME: '/home/alice/.xdgconfig' }
      })
    ).toBe('/home/alice/.xdgconfig/opencode')
  })

  test('Linux falls back to ~/.config/opencode', () => {
    expect(resolvePlatformConfigDir({ platform: 'linux', home: HOME_NIX, env: {} })).toBe(
      '/home/alice/.config/opencode'
    )
  })

  test('XDG_CONFIG_HOME wins on Windows too (Servoy sets it to ~/.servoy)', () => {
    // Servoy launches opencode with XDG_CONFIG_HOME=~/.servoy on every platform,
    // so opencode.json lands in ~/.servoy/opencode. kiro.json must follow it
    // there — not split off into %APPDATA% — so the config wins over APPDATA.
    expect(
      resolvePlatformConfigDir({
        platform: 'win32',
        home: HOME_WIN,
        env: {
          XDG_CONFIG_HOME: 'C:\\Users\\alice\\.servoy',
          APPDATA: 'C:\\Users\\alice\\AppData\\Roaming'
        }
      })
    ).toBe('C:\\Users\\alice\\.servoy\\opencode')
  })

  test('XDG_CONFIG_HOME wins on macOS (Servoy isolation)', () => {
    expect(
      resolvePlatformConfigDir({
        platform: 'darwin',
        home: HOME_NIX,
        env: { XDG_CONFIG_HOME: '/home/alice/.servoy' }
      })
    ).toBe('/home/alice/.servoy/opencode')
  })

  test('KIRO_IGNORE_XDG=true ignores XDG_CONFIG_HOME and uses the platform default', () => {
    // Opt-out for hosts (Servoy) that relocate XDG but want the plugin to stay
    // on the OS default anyway. macOS: XDG is ignored, so ~/.config/opencode.
    expect(
      resolvePlatformConfigDir({
        platform: 'darwin',
        home: HOME_NIX,
        env: { XDG_CONFIG_HOME: '/home/alice/.servoy', KIRO_IGNORE_XDG: 'true' }
      })
    ).toBe('/home/alice/.config/opencode')
  })

  test('KIRO_IGNORE_XDG=true still lets Windows use %APPDATA%, not the ignored XDG', () => {
    expect(
      resolvePlatformConfigDir({
        platform: 'win32',
        home: HOME_WIN,
        env: {
          XDG_CONFIG_HOME: 'C:\\Users\\alice\\.servoy',
          APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
          KIRO_IGNORE_XDG: 'true'
        }
      })
    ).toBe('C:\\Users\\alice\\AppData\\Roaming\\opencode')
  })

  test('KIRO_IGNORE_XDG only takes effect when set to exactly "true"', () => {
    // A stray "false"/"0"/"" must not silently disable XDG.
    for (const value of ['false', '0', '', '1', 'yes']) {
      expect(
        resolvePlatformConfigDir({
          platform: 'darwin',
          home: HOME_NIX,
          env: { XDG_CONFIG_HOME: '/home/alice/.servoy', KIRO_IGNORE_XDG: value }
        })
      ).toBe('/home/alice/.servoy/opencode')
    }
  })
})

describe('platform cache dir: regenerable data location per OS', () => {
  const HOME_NIX = '/home/alice'
  const HOME_WIN = 'C:\\Users\\alice'

  test('Windows uses %LOCALAPPDATA%\\opencode (Local, not roamed)', () => {
    expect(
      resolvePlatformCacheDir({
        platform: 'win32',
        home: HOME_WIN,
        env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' }
      })
    ).toBe('C:\\Users\\alice\\AppData\\Local\\opencode')
  })

  test('Windows falls back to ~/AppData/Local when LOCALAPPDATA is unset', () => {
    expect(resolvePlatformCacheDir({ platform: 'win32', home: HOME_WIN, env: {} })).toBe(
      'C:\\Users\\alice\\AppData\\Local\\opencode'
    )
  })

  test('macOS uses ~/Library/Caches/opencode (native cache location)', () => {
    expect(resolvePlatformCacheDir({ platform: 'darwin', home: HOME_NIX, env: {} })).toBe(
      '/home/alice/Library/Caches/opencode'
    )
  })

  test('Linux honours XDG_CACHE_HOME', () => {
    expect(
      resolvePlatformCacheDir({
        platform: 'linux',
        home: HOME_NIX,
        env: { XDG_CACHE_HOME: '/home/alice/.xdgcache' }
      })
    ).toBe('/home/alice/.xdgcache/opencode')
  })

  test('Linux falls back to ~/.cache/opencode', () => {
    expect(resolvePlatformCacheDir({ platform: 'linux', home: HOME_NIX, env: {} })).toBe(
      '/home/alice/.cache/opencode'
    )
  })

  test('KIRO_IGNORE_XDG=true ignores XDG_CACHE_HOME and uses the platform default', () => {
    // macOS ignores XDG cache and uses the native ~/Library/Caches location.
    expect(
      resolvePlatformCacheDir({
        platform: 'darwin',
        home: HOME_NIX,
        env: { XDG_CACHE_HOME: '/home/alice/.servoy', KIRO_IGNORE_XDG: 'true' }
      })
    ).toBe('/home/alice/Library/Caches/opencode')
  })

  test('XDG_CACHE_HOME wins on every platform (Servoy sets it to ~/.servoy)', () => {
    // Servoy points all four XDG bases at ~/.servoy, so cache also converges
    // there — on Windows and macOS, where the native fallback would differ.
    expect(
      resolvePlatformCacheDir({
        platform: 'win32',
        home: HOME_WIN,
        env: {
          XDG_CACHE_HOME: 'C:\\Users\\alice\\.servoy',
          LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local'
        }
      })
    ).toBe('C:\\Users\\alice\\.servoy\\opencode')
    expect(
      resolvePlatformCacheDir({
        platform: 'darwin',
        home: HOME_NIX,
        env: { XDG_CACHE_HOME: '/home/alice/.servoy' }
      })
    ).toBe('/home/alice/.servoy/opencode')
  })

  test('with Servoy XDG isolation, config and cache converge (both under ~/.servoy/opencode)', () => {
    // All four XDG bases at ~/.servoy means opencode collapses config and cache
    // into one ~/.servoy/opencode dir; the plugin must land in the same place.
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const home = platform === 'win32' ? 'C:\\Users\\alice' : '/home/alice'
      const servoy = platform === 'win32' ? 'C:\\Users\\alice\\.servoy' : '/home/alice/.servoy'
      const env = { XDG_CONFIG_HOME: servoy, XDG_CACHE_HOME: servoy }
      expect(resolvePlatformConfigDir({ platform, home, env })).toBe(
        resolvePlatformCacheDir({ platform, home, env })
      )
    }
  })

  test('cache and config resolve to different dirs on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const home = platform === 'win32' ? 'C:\\Users\\alice' : '/home/alice'
      const config = resolvePlatformConfigDir({ platform, home, env: {} })
      const cache = resolvePlatformCacheDir({ platform, home, env: {} })
      expect(cache).not.toBe(config)
    }
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
