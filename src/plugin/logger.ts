import { Buffer } from 'node:buffer'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from './config/paths'
import { redactSecrets } from './redact'

/** Size cap for kiro-plugin.log before it rotates to kiro-plugin.log.1. */
export const LOG_MAX_BYTES = 10 * 1024 * 1024

/** How long a per-request API dump lives before cleanupApiLogs removes it. */
export const API_LOG_TTL_MS = 24 * 60 * 60 * 1000

const LOG_FILENAME = 'kiro-plugin.log'
const LEGACY_LOG_FILENAME = 'plugin.log'

const binaryToBase64Replacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  return value
}

/**
 * The directory kiro-plugin.log is written to: the config dir, always.
 *
 * There is no separate log-dir override — a log that can move on its own is a
 * log nobody can find, which is the bug this removed. Move the whole set (log,
 * kiro.json, kiro.db) together with KIRO_CONFIG_DIR.
 */
export const getLogDir = (): string => getConfigDir()

/**
 * Where per-request API dumps go: a `kiro-log/` subdir of the config dir.
 *
 * Kept out of the config dir itself so turning on request logging does not
 * scatter loose JSON next to kiro.json, kiro.db and kiro-plugin.log.
 */
export const getApiLogDir = (): string => join(getConfigDir(), 'kiro-log')

/** The active log file: kiro-plugin.log in the config dir. */
export const getLogPath = (): string => join(getLogDir(), LOG_FILENAME)

/**
 * Rename a pre-existing plugin.log to the kiro-prefixed name so an upgrade
 * carries its history forward instead of orphaning it next to kiro.json. Silent
 * and best-effort: a missing legacy file or a failed rename must never block a
 * log write.
 */
const migrateLegacyLog = (dir: string): void => {
  const legacy = join(dir, LEGACY_LOG_FILENAME)
  const current = join(dir, LOG_FILENAME)
  try {
    if (existsSync(legacy) && !existsSync(current)) renameSync(legacy, current)
  } catch {}
}

/**
 * Rotate the log when it passes the size cap: the current file becomes
 * kiro-plugin.log.1 (overwriting any previous generation) and a fresh file
 * starts. One generation is kept — enough to span the rotation boundary without
 * letting logs grow without bound.
 */
const rotateIfNeeded = (path: string): void => {
  try {
    if (!existsSync(path)) return
    if (statSync(path).size < LOG_MAX_BYTES) return
    renameSync(path, `${path}.1`)
  } catch {}
}

/**
 * Remove per-request API dumps older than API_LOG_TTL_MS. These carry full
 * conversation content, so stale ones are both clutter and a disclosure risk;
 * cleanup runs opportunistically when a new dump is written.
 */
export const cleanupApiLogs = (): void => {
  try {
    const dir = getApiLogDir()
    if (!existsSync(dir)) return
    const cutoff = Date.now() - API_LOG_TTL_MS
    for (const name of readdirSync(dir)) {
      const file = join(dir, name)
      try {
        if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true })
      } catch {}
    }
  } catch {}
}

const writeToFile = (level: string, message: string, ...args: unknown[]) => {
  try {
    const dir = getLogDir()
    mkdirSync(dir, { recursive: true })
    migrateLegacyLog(dir)
    const path = join(dir, LOG_FILENAME)
    rotateIfNeeded(path)
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
    const dir = getApiLogDir()
    mkdirSync(dir, { recursive: true })
    const prefix = isError ? 'error_' : ''
    const filename = `${prefix}${timestamp}_${type}.json`
    const path = join(dir, filename)
    const content = JSON.stringify(data, binaryToBase64Replacer, 2)
    writeFileSync(path, redactSecrets(content))
    cleanupApiLogs()
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
  error(`${errorType} on ${email} - See kiro-log/error_${timestamp}_request.json`)
}

export function getTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}
