import type { Effort } from './config/schema'

/**
 * Effort levels ordered from lowest to highest reasoning depth.
 */
export const EFFORT_LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Models that support the 5-value effort enum (including xhigh).
 * These models support up to 128k thinking tokens with max effort.
 */
const XHIGH_CAPABLE_MODELS = new Set([
  'claude-opus-4.7',
  'claude-opus-4.8'
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

  // xhigh is only supported on opus-4.7 and opus-4.8
  if (requested === 'xhigh' && !supportsXHighEffort(kiroModel)) {
    return 'max'
  }

  return requested
}

/**
 * Map OpenCode thinking budget to Kiro effort level.
 * 
 * Budget ranges (approximate thinking token allocations):
 * - low:    minimal thinking
 * - medium: ~20k tokens (OpenCode default)
 * - high:   ~50k tokens
 * - xhigh:  ~80k tokens (opus-4.7/4.8 only)
 * - max:    ~128k tokens
 */
export function budgetToEffort(budget: number, kiroModel: string): Effort | undefined {
  if (!supportsEffort(kiroModel)) {
    return undefined
  }

  let effort: Effort
  if (budget <= 10000) {
    effort = 'low'
  } else if (budget <= 30000) {
    effort = 'medium'
  } else if (budget <= 60000) {
    effort = 'high'
  } else if (budget <= 100000) {
    effort = supportsXHighEffort(kiroModel) ? 'xhigh' : 'max'
  } else {
    effort = 'max'
  }

  return effort
}

/**
 * Get the effective effort level based on config, budget, and model.
 * 
 * Priority:
 * 1. Explicit effort config (if set) - always applied regardless of thinking state
 * 2. Budget-to-effort mapping (if auto_effort_mapping enabled and thinking)
 * 3. 'medium' default (if thinking enabled)
 * 4. undefined (if not thinking)
 */
export function getEffectiveEffort(
  kiroModel: string,
  thinking: boolean,
  budget: number,
  configEffort?: Effort,
  autoEffortMapping = true
): Effort | undefined {
  if (!supportsEffort(kiroModel)) {
    return undefined
  }

  // Explicit config takes precedence - always applied even without thinking
  if (configEffort) {
    return resolveEffort(kiroModel, configEffort)
  }

  // If not thinking, no effort needed
  if (!thinking) {
    return undefined
  }

  // Auto-map budget to effort
  if (autoEffortMapping) {
    return budgetToEffort(budget, kiroModel)
  }

  // Default to medium when thinking without auto-mapping
  return 'medium'
}
