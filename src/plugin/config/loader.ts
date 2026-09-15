import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import * as logger from '../logger'
import { getConfigDir, getDefaultLogsDir } from './paths'
import {
  AccountSelectionStrategySchema,
  DEFAULT_CONFIG,
  KiroConfigSchema,
  RegionSchema,
  RETIRED_SETTINGS,
  type KiroConfig
} from './schema'

export { getConfigDir, getDefaultLogsDir }

export function getUserConfigPath(): string {
  return join(getConfigDir(), 'kiro.json')
}

/**
 * Make sure the user's config lists every setting that has a default.
 *
 * The template was written once, at creation, so a setting added later never
 * appeared in a file that already existed — it was real, documented nowhere,
 * and invisible to anyone who did not read the source. Missing keys are
 * appended with their default, which changes no behaviour and makes the file
 * say what it is doing. Values already there are left exactly as they are.
 *
 * Settings with no default stay out: writing a value for `effort` or
 * `prompt_caching` would turn them on rather than describe them.
 */
function ensureUserConfigTemplate(): void {
  const path = getUserConfigPath()

  if (!existsSync(path)) {
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8')
      logger.log(`Created default config template at ${path}`)
    } catch (error) {
      logger.warn(`Failed to create config template at ${path}: ${String(error)}`)
    }
    return
  }

  if (!needsTopUp(path)) return

  // Every project on this machine loads its own copy of the plugin and they
  // start together, so the read-modify-write is serialised. mkdir is the lock:
  // it either creates the directory or fails, atomically, on every filesystem.
  const lock = `${path}.lock`
  try {
    mkdirSync(lock)
  } catch {
    return takeOverStaleLock(lock) ? topUpConfig(path, lock) : undefined
  }
  topUpConfig(path, lock)
}

/** Whether the file is missing a default, or still lists a retired setting. */
function needsTopUp(path: string): boolean {
  try {
    const current = JSON.parse(readFileSync(path, 'utf-8'))
    if (!current || typeof current !== 'object' || Array.isArray(current)) return false

    const unknown = Object.keys(current).filter(
      (key) => key !== '$schema' && !(key in DEFAULT_CONFIG) && !isRetired(key) && !isOptional(key)
    )
    if (unknown.length > 0) {
      logger.warn('Config: unknown setting(s), left untouched', { settings: unknown })
    }

    return (
      Object.keys(DEFAULT_CONFIG).some((key) => !(key in current)) ||
      RETIRED_SETTINGS.some((key) => key in current)
    )
  } catch {
    return false
  }
}

const OPTIONAL_SETTINGS = ['idc_start_url', 'idc_region', 'idc_profile_arn']
const isOptional = (key: string): boolean => OPTIONAL_SETTINGS.includes(key)
const isRetired = (key: string): boolean => (RETIRED_SETTINGS as readonly string[]).includes(key)

/**
 * A lock left behind by a process that died is not a lock. Two minutes is far
 * longer than this ever takes and far shorter than a user would wait.
 */
function takeOverStaleLock(lock: string): boolean {
  try {
    if (Date.now() - statSync(lock).mtimeMs < 2 * 60 * 1000) return false
    rmSync(lock, { recursive: true, force: true })
    mkdirSync(lock)
    return true
  } catch {
    return false
  }
}

function topUpConfig(path: string, lock: string): void {
  try {
    // Read again inside the lock: another project may have just written, and
    // so may the user's editor.
    const merged = JSON.parse(readFileSync(path, 'utf-8'))
    const missing = Object.keys(DEFAULT_CONFIG).filter((key) => !(key in merged))
    const retired = RETIRED_SETTINGS.filter((key) => key in merged)
    if (missing.length === 0 && retired.length === 0) return

    for (const key of missing) {
      merged[key] = DEFAULT_CONFIG[key as keyof typeof DEFAULT_CONFIG]
    }
    for (const key of retired) delete merged[key]
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8')
    renameSync(tmp, path)
    if (missing.length > 0) logger.log('Config: added missing defaults', { settings: missing })
    if (retired.length > 0) logger.log('Config: removed retired settings', { settings: retired })
  } catch {
    // A file we cannot read or write is the user's to fix; the defaults still
    // apply in memory either way.
  } finally {
    try {
      rmSync(lock, { recursive: true, force: true })
    } catch {
      // Left behind, and reclaimed as stale by whoever comes next.
    }
  }
}

export function getProjectConfigPath(directory: string): string {
  return join(directory, '.opencode', 'kiro.json')
}

function loadConfigFile(path: string): Partial<KiroConfig> | null {
  try {
    if (!existsSync(path)) {
      return null
    }

    const content = readFileSync(path, 'utf-8')
    const rawConfig = JSON.parse(content)

    const result = KiroConfigSchema.partial().safeParse(rawConfig)

    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')
      logger.warn(`Config validation error at ${path}: ${issues}`)
      return null
    }

    return result.data
  } catch (error) {
    if (error instanceof SyntaxError) {
      logger.warn(`Invalid JSON in config file ${path}: ${error.message}`)
    } else {
      logger.warn(`Failed to load config file ${path}: ${String(error)}`)
    }
    return null
  }
}

function mergeConfigs(base: KiroConfig, override: Partial<KiroConfig>): KiroConfig {
  return {
    ...base,
    ...override
  }
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback
  }
  if (value === '1' || value === 'true') {
    return true
  }
  if (value === '0' || value === 'false') {
    return false
  }
  return fallback
}

function parseNumberEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback
  }
  const parsed = Number(value)
  if (isNaN(parsed)) {
    return fallback
  }
  return parsed
}

function applyEnvOverrides(config: KiroConfig): KiroConfig {
  const env = process.env

  return {
    ...config,

    account_selection_strategy: env.KIRO_ACCOUNT_SELECTION_STRATEGY
      ? AccountSelectionStrategySchema.catch('lowest-usage').parse(
          env.KIRO_ACCOUNT_SELECTION_STRATEGY
        )
      : config.account_selection_strategy,

    default_region: env.KIRO_DEFAULT_REGION
      ? RegionSchema.catch('us-east-1').parse(env.KIRO_DEFAULT_REGION)
      : config.default_region,

    rate_limit_retry_delay_ms: parseNumberEnv(
      env.KIRO_RATE_LIMIT_RETRY_DELAY_MS,
      config.rate_limit_retry_delay_ms
    ),

    rate_limit_max_retries: parseNumberEnv(
      env.KIRO_RATE_LIMIT_MAX_RETRIES,
      config.rate_limit_max_retries
    ),

    max_request_iterations: parseNumberEnv(
      env.KIRO_MAX_REQUEST_ITERATIONS,
      config.max_request_iterations
    ),

    request_timeout_ms: parseNumberEnv(env.KIRO_REQUEST_TIMEOUT_MS, config.request_timeout_ms),

    token_expiry_buffer_ms: parseNumberEnv(
      env.KIRO_TOKEN_EXPIRY_BUFFER_MS,
      config.token_expiry_buffer_ms
    ),

    usage_sync_max_retries: parseNumberEnv(
      env.KIRO_USAGE_SYNC_MAX_RETRIES,
      config.usage_sync_max_retries
    ),

    usage_tracking_enabled: parseBooleanEnv(
      env.KIRO_USAGE_TRACKING_ENABLED,
      config.usage_tracking_enabled
    ),

    enable_log_api_request: parseBooleanEnv(
      env.KIRO_ENABLE_LOG_API_REQUEST,
      config.enable_log_api_request
    )
  }
}

export function loadConfig(directory: string): KiroConfig {
  ensureUserConfigTemplate()
  let config: KiroConfig = { ...DEFAULT_CONFIG }

  const userConfigPath = getUserConfigPath()
  const userConfig = loadConfigFile(userConfigPath)
  if (userConfig) {
    config = mergeConfigs(config, userConfig)
  }

  const projectConfigPath = getProjectConfigPath(directory)
  const projectConfig = loadConfigFile(projectConfigPath)
  if (projectConfig) {
    config = mergeConfigs(config, projectConfig)
  }

  config = applyEnvOverrides(config)

  return config
}

export function configExists(path: string): boolean {
  return existsSync(path)
}
