import type { Effort } from './config/schema.js'
import { isEffort, THINKING_BUDGETS } from './effort.js'
import { EFFORT_OFF } from './model-request-fields.js'

/** What one request asks for, read from the body OpenCode sends. */
export interface RequestOptions {
  /** The effort level the chosen variant names, when it names a known one. */
  requestedEffort?: Effort
  /** True when the variant is `off`, which is a choice and not an absence. */
  thinkingDisabled: boolean
  /** Whether anything asked the model to reason. */
  think: boolean
  /** Token ceiling for the answer, when one was asked for. */
  maxTokens?: number
  /** A number for the <thinking_mode> prefix to state a ceiling with. */
  budget: number
}

/**
 * Read the options off a request body.
 *
 * OpenCode sends the chosen variant as a top-level `reasoning_effort` and the
 * ceiling as a top-level `max_tokens`. Reading them anywhere else is how the
 * dial came to do nothing for as long as it did — so this lives on its own,
 * where a test can call the same code the handler runs rather than restate it.
 */
export function readRequestOptions(body: any, model: string): RequestOptions {
  const reasoningEffort: unknown = body?.reasoning_effort

  const thinkingDisabled = reasoningEffort === EFFORT_OFF
  const think = !thinkingDisabled && (model.endsWith('-thinking') || !!reasoningEffort)
  const requestedEffort = isEffort(reasoningEffort) ? reasoningEffort : undefined

  const rawMax = body?.max_tokens
  const maxTokens = typeof rawMax === 'number' && rawMax > 0 ? rawMax : undefined

  return {
    requestedEffort,
    thinkingDisabled,
    think,
    maxTokens,
    budget: THINKING_BUDGETS[requestedEffort ?? 'medium']
  }
}
