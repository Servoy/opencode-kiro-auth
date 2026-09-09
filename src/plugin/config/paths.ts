import { homedir } from 'node:os'
import { join } from 'node:path'

let cachedBaseDir: string | undefined

function resolveBaseDir(): string {
  if (process.env.KIRO_CONFIG_DIR) return process.env.KIRO_CONFIG_DIR
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'opencode')
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
}

export function getConfigDir(): string {
  if (!cachedBaseDir) cachedBaseDir = resolveBaseDir()
  return cachedBaseDir
}

export function getDefaultLogsDir(): string {
  return getConfigDir()
}
