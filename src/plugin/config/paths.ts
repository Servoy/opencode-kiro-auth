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

/**
 * Walk up a module path to the opencode install that owns it.
 *
 * Distributions relocate opencode's data dir (Servoy ships ~/.servoy/opencode)
 * and install plugins underneath it, so the platform config dir is not a
 * reliable place to look for a provisioned kiro.json.
 */
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

/** Pick the config dir, preferring one that already holds a kiro.json. */
export function pickConfigDir(
  installDir: string | undefined,
  platformDir: string,
  hasConfig: (dir: string) => boolean
): string {
  if (installDir && hasConfig(installDir)) return installDir
  if (hasConfig(platformDir)) return platformDir
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

  // The suite eagerly opens kiro.db and appends to plugin.log; without this it
  // does that to the developer's real ones.
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

/** Test-only: the resolved dir is cached for the process lifetime. */
export function resetConfigDirCache(): void {
  cachedBaseDir = undefined
}
