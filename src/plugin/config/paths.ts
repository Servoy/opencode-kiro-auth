import { homedir } from 'node:os'
import { join } from 'node:path'

export function getConfigDir(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'opencode')
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
}

export function getDefaultLogsDir(): string {
  return getConfigDir()
}
