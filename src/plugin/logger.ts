import { Buffer } from 'node:buffer'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from './config/paths'
import { redactSecrets } from './redact'

const binaryToBase64Replacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  return value
}

/**
 * The directory plugin.log is written to: the config dir, always.
 *
 * There is no separate log-dir override — a log that can move on its own is a
 * log nobody can find, which is the bug this removed. Move the whole set (log,
 * kiro.json, kiro.db) together with KIRO_CONFIG_DIR.
 */
export const getLogDir = (): string => getConfigDir()

const writeToFile = (level: string, message: string, ...args: unknown[]) => {
  try {
    const dir = getLogDir()
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'plugin.log')
    const timestamp = new Date().toISOString()
    const content = `[${timestamp}] ${level}: ${message} ${args
      .map((a) => {
        if (a instanceof Error) {
          return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ''}`
        }
        if (typeof a === 'object') {
          try {
            return JSON.stringify(a)
          } catch {
            return '[Unserializable object]'
          }
        }
        return String(a)
      })
      .join(' ')}\n`
    appendFileSync(path, redactSecrets(content))
  } catch (e) {}
}

const writeApiLog = (
  type: 'request' | 'response',
  data: any,
  timestamp: string,
  isError = false
) => {
  try {
    const dir = getLogDir()
    mkdirSync(dir, { recursive: true })
    const prefix = isError ? 'error_' : ''
    const filename = `${prefix}${timestamp}_${type}.json`
    const path = join(dir, filename)
    const content = JSON.stringify(data, binaryToBase64Replacer, 2)
    writeFileSync(path, redactSecrets(content))
  } catch (e) {}
}

export function log(message: string, ...args: unknown[]): void {
  writeToFile('INFO', message, ...args)
}

/** Alias for {@link log}, for callers that reach for the conventional name. */
export function info(message: string, ...args: unknown[]): void {
  log(message, ...args)
}

export function error(message: string, ...args: unknown[]): void {
  writeToFile('ERROR', message, ...args)
}

export function warn(message: string, ...args: unknown[]): void {
  writeToFile('WARN', message, ...args)
}

let debugEnabled = false

/** Turn on the debug-level diagnostics, from kiro.json's `trace`. */
export function setDebugEnabled(enabled: boolean): void {
  debugEnabled = enabled
}

export function debug(message: string, ...args: unknown[]): void {
  if (debugEnabled || process.env.DEBUG || process.env.OPENCODE_LOG_LEVEL === 'debug') {
    writeToFile('DEBUG', message, ...args)
  }
}

export function logApiRequest(data: any, timestamp: string): void {
  writeApiLog('request', data, timestamp)
}

export function logApiResponse(data: any, timestamp: string): void {
  writeApiLog('response', data, timestamp)
}

export function logApiError(requestData: any, responseData: any, timestamp: string): void {
  writeApiLog('request', requestData, timestamp, true)
  writeApiLog('response', responseData, timestamp, true)
  const errorType = responseData.status ? `HTTP ${responseData.status}` : 'Network Error'
  const email = requestData.email || 'unknown'
  error(`${errorType} on ${email} - See error_${timestamp}_request.json`)
}

export function getTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}
