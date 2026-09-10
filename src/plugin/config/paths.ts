import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

let cachedBaseDir: string | undefined

function platformConfigDir(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'opencode')
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
}

// opencode does not always live in the platform config dir — distributions
// relocate its data dir (Servoy's ships as ~/.servoy/opencode) and install
// plugins underneath it. Deriving the dir from this module's own location is
// the only reliable way to find the kiro.json that was provisioned next to the
// opencode install; guessing the platform dir instead silently ignores it and
// writes a fresh default template somewhere the user never looks.
export function findOpencodeInstallDir(
  modulePath: string,
  separator: string = sep
): string | undefined {
  const parts = modulePath.split(separator)
  const index = parts.lastIndexOf('opencode')
  if (index <= 0) return undefined
  return parts.slice(0, index + 1).join(separator)
}

function opencodeInstallDir(): string | undefined {
  try {
    return findOpencodeInstallDir(dirname(fileURLToPath(import.meta.url)))
  } catch {
    return undefined
  }
}

export function pickConfigDir(
  installDir: string | undefined,
  platformDir: string,
  hasConfig: (dir: string) => boolean
): string {
  // An existing config wins over both defaults, so nobody's settings move.
  if (installDir && hasConfig(installDir)) return installDir
  if (hasConfig(platformDir)) return platformDir

  // Nothing yet: provision next to the opencode install that loaded us.
  return installDir ?? platformDir
}

function configExists(dir: string): boolean {
  try {
    return existsSync(join(dir, 'kiro.json'))
  } catch {
    return false
  }
}

function resolveBaseDir(): string {
  if (process.env.KIRO_CONFIG_DIR) return process.env.KIRO_CONFIG_DIR

  // The suite imports modules that eagerly open kiro.db and append to
  // plugin.log. Without this, running the tests mutates the developer's own
  // account database and litters their log with fake accounts and simulated
  // failures — which is exactly the file they read when debugging for real.
  if (process.env.NODE_ENV === 'test') return join(tmpdir(), 'kiro-plugin-test-config')

  return pickConfigDir(opencodeInstallDir(), platformConfigDir(), configExists)
}

export function getConfigDir(): string {
  if (!cachedBaseDir) cachedBaseDir = resolveBaseDir()
  return cachedBaseDir
}

export function getDefaultLogsDir(): string {
  return getConfigDir()
}

// Test-only: the resolved dir is cached for the process lifetime.
export function resetConfigDirCache(): void {
  cachedBaseDir = undefined
}
