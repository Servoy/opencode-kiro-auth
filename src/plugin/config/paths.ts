import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const APP = 'opencode'

let cachedBaseDir: string | undefined
let cachedCacheDir: string | undefined

/** The pieces of the environment the platform resolvers depend on. */
export interface PlatformEnv {
  platform: NodeJS.Platform
  home: string
  env: Record<string, string | undefined>
}

function currentEnv(): PlatformEnv {
  return { platform: process.platform, home: homedir(), env: process.env }
}

// Join with the target platform's separator, not node:path's host-dependent
// one, so one runner can verify every OS layout. At runtime platform is the
// host, so the result equals path.join.
function joinFor(platform: NodeJS.Platform, ...parts: string[]): string {
  const separator = platform === 'win32' ? '\\' : '/'
  return parts.join(separator)
}

/**
 * The plugin's state dir (kiro.json, kiro.db, plugin.log), matching where
 * OpenCode keeps its own global config so the two sit together:
 *
 * - `XDG_CONFIG_HOME` set (any OS): `$XDG_CONFIG_HOME/opencode`
 * - Windows: `%APPDATA%\opencode`
 * - macOS/Linux: `~/.config/opencode`
 *
 * XDG wins on every platform, Windows included, because that is how OpenCode's
 * own resolver behaves — honouring it only on POSIX would strand kiro.json in
 * `%APPDATA%` when Servoy relocates everything to `~/.servoy` via XDG.
 */
export function resolvePlatformConfigDir({ platform, home, env }: PlatformEnv): string {
  if (env.XDG_CONFIG_HOME) return joinFor(platform, env.XDG_CONFIG_HOME, APP)
  if (platform === 'win32') {
    return joinFor(platform, env.APPDATA || joinFor(platform, home, 'AppData', 'Roaming'), APP)
  }
  return joinFor(platform, joinFor(platform, home, '.config'), APP)
}

/**
 * The regenerable-data dir (converted-image cache), in each platform's
 * throwaway-data location since losing it costs a re-fetch, not a re-login:
 *
 * - `XDG_CACHE_HOME` set (any OS): `$XDG_CACHE_HOME/opencode`
 * - Windows: `%LOCALAPPDATA%\opencode`
 * - macOS: `~/Library/Caches/opencode`
 * - Linux: `~/.cache/opencode`
 *
 * XDG wins everywhere for the same reason as the config dir.
 */
export function resolvePlatformCacheDir({ platform, home, env }: PlatformEnv): string {
  if (env.XDG_CACHE_HOME) return joinFor(platform, env.XDG_CACHE_HOME, APP)
  if (platform === 'win32') {
    return joinFor(platform, env.LOCALAPPDATA || joinFor(platform, home, 'AppData', 'Local'), APP)
  }
  if (platform === 'darwin') {
    return joinFor(platform, home, 'Library', 'Caches', APP)
  }
  return joinFor(platform, joinFor(platform, home, '.cache'), APP)
}

function platformConfigDir(): string {
  return resolvePlatformConfigDir(currentEnv())
}

function platformCacheDir(): string {
  return resolvePlatformCacheDir(currentEnv())
}

/**
 * Resolve one of the plugin's base directories, in precedence order:
 * explicit override → an isolated dir under tmp while testing → the
 * platform default. Pure in its inputs so every branch is testable without
 * touching process state.
 *
 * The test branch matters: the suite eagerly opens kiro.db and appends to
 * plugin.log, so without an isolated dir it would write to the developer's
 * real ones.
 */
export function resolveDir(opts: {
  override: string | undefined
  isTest: boolean
  testDirName: string
  platformDir: () => string
}): string {
  if (opts.override) return opts.override
  if (opts.isTest) return join(tmpdir(), opts.testDirName)
  return opts.platformDir()
}

/**
 * The one directory the plugin's state lives in: kiro.json, kiro.db and
 * plugin.log all sit here, so finding the config finds the log.
 *
 * Resolved once and cached for the life of the module instance. The choice
 * must be stable: a plugin.log that resolves to one place at startup and
 * another after a kiro.json appears is a log split across two files, which is
 * the bug this caching prevents. Set KIRO_CONFIG_DIR to move the whole set.
 *
 * The platform default follows OpenCode's own config dir. We used to walk the
 * module path back to the nearest `opencode` segment, but modern OpenCode
 * installs plugins under its *cache* (`~/.cache/opencode/packages/...`), so
 * that walk landed state in the cache on one machine and %APPDATA% on another —
 * the "why is it here and not there" bug. The platform config dir is identical
 * everywhere and puts the plugin's state right next to OpenCode's own.
 */
export function getConfigDir(): string {
  if (!cachedBaseDir) {
    cachedBaseDir = resolveDir({
      override: process.env.KIRO_CONFIG_DIR,
      isTest: process.env.NODE_ENV === 'test',
      testDirName: 'kiro-plugin-test-config',
      platformDir: platformConfigDir
    })
  }
  return cachedBaseDir
}

/**
 * Where regenerable data goes — currently the converted-image cache. Kept
 * apart from the config dir on purpose: this is disposable (24h TTL, safe to
 * delete), so it belongs in the OS cache location, not next to credentials and
 * state. Set KIRO_CACHE_DIR to relocate it.
 */
export function getCacheDir(): string {
  if (!cachedCacheDir) {
    cachedCacheDir = resolveDir({
      override: process.env.KIRO_CACHE_DIR,
      isTest: process.env.NODE_ENV === 'test',
      testDirName: 'kiro-plugin-test-cache',
      platformDir: platformCacheDir
    })
  }
  return cachedCacheDir
}
