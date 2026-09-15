import type { Effort } from './config/schema'

/**
 * Effort levels ordered from lowest to highest reasoning depth.
 */
export const EFFORT_LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** True when a value from OpenCode names one of the levels Kiro accepts. */
export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value)
}

/**
 * Reference thinking budget for each effort level.
 *
 * The <thinking_mode> prefix states a ceiling in tokens, and these are the
 * numbers it uses. Scaled to Kiro's real range (1024–128000 on opus-4.8 and
 * opus-5) rather than OpenCode's conventional 32768 cap.
 */
export const THINKING_BUDGETS: Readonly<Record<Effort, number>> = {
  low: 16384,
  medium: 32768,
  high: 65536,
  xhigh: 98304,
  max: 128000
}

/**
 * Models that support the 5-value effort enum (including xhigh).
 * Per Kiro's effort docs, this is opus-4.7/4.8/5 and sonnet-5.
 */
const XHIGH_CAPABLE_MODELS = new Set([
  'claude-opus-4.7',
  'claude-opus-4.8',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-sonnet-5-1m'
])

/**
 * Models that support the 4-value effort enum (no xhigh).
 * xhigh requests on these models are clamped to max.
 */
const EFFORT_CAPABLE_MODELS = new Set([
  'claude-opus-4.5',
  'claude-opus-4.6',
  'claude-opus-4.6-1m',
  'claude-sonnet-4.5',
  'claude-sonnet-4.5-1m',
  'claude-sonnet-4.6',
  'claude-sonnet-4.6-1m',
  ...XHIGH_CAPABLE_MODELS
])

/**
 * Check if a model supports the effort parameter.
 */
export function supportsEffort(kiroModel: string): boolean {
  return EFFORT_CAPABLE_MODELS.has(kiroModel)
}

/**
 * Check if a model supports xhigh effort level.
 */
export function supportsXHighEffort(kiroModel: string): boolean {
  return XHIGH_CAPABLE_MODELS.has(kiroModel)
}

/**
 * Resolve effort level for a given model.
 * - Returns undefined if model doesn't support effort
 * - Clamps xhigh to max for models that don't support it
 */
export function resolveEffort(kiroModel: string, requested: Effort): Effort | undefined {
  if (!supportsEffort(kiroModel)) {
    return undefined
  }

  // xhigh is only supported on the models in XHIGH_CAPABLE_MODELS
  if (requested === 'xhigh' && !supportsXHighEffort(kiroModel)) {
    return 'max'
  }

  return requested
}

/**
 * The effort level a request should carry, or undefined to let Kiro decide.
 *
 * Undefined is not "no thinking" — the service then applies its own default,
 * which its catalog reports as high. Only thinking.type = disabled turns it off.
 */
export function getEffectiveEffort(
  kiroModel: string,
  thinking: boolean,
  requested?: Effort
): Effort | undefined {
  if (!supportsEffort(kiroModel)) return undefined
  if (requested) return resolveEffort(kiroModel, requested)
  return thinking ? 'medium' : undefined
}
