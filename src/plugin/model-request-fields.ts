import type { Effort } from './config/schema.js'
import { getCatalogCapabilities } from './models.js'

/** The dial position that actually stops the model reasoning. */
export const EFFORT_OFF = 'off' as const

/**
 * The `additionalModelRequestFields` block, as the service names its members.
 *
 * The outer key is camelCase and everything inside it stays snake_case — that
 * is what the Kiro CLI puts on the wire, and the service reads it literally.
 */
export interface AdditionalModelRequestFields {
  /** Claude family reasoning channel. */
  output_config?: { effort: Effort }
  /** GPT family reasoning channel; the service reads one or the other. */
  reasoning?: { effort: Effort }
  /** Adaptive is the service default; disabled is the only real off switch. */
  thinking?: { type: 'adaptive' | 'disabled' }
  max_tokens?: number
}

/** GPT models take their effort under `reasoning`, every other family under
 *  `output_config`. Sending both is not accepted. */
function isGptFamily(kiroModel: string): boolean {
  return /^(gpt|openai)/i.test(kiroModel)
}

/**
 * Build the block for one request, or undefined when nothing needs saying.
 *
 * Leaving the block off is not the same as turning thinking off: with no
 * effort the service applies its own default, which the catalog reports as
 * `high`. Only `thinking.type = disabled` actually stops it.
 */
export function buildModelRequestFields(
  kiroModel: string,
  effort: Effort | undefined,
  thinkingDisabled: boolean,
  maxTokens?: number
): AdditionalModelRequestFields | undefined {
  // Models without a reasoning schema reject the block outright — "is not
  // supported for this model", a 400 before a single token. Compared against
  // false rather than truthiness so a catalog that could not be read leaves
  // every model alone instead of silently stripping the block from all of them.
  if (getCatalogCapabilities(kiroModel)?.supportsRequestFields === false) return undefined

  const fields: AdditionalModelRequestFields = {}

  if (thinkingDisabled) {
    fields.thinking = { type: 'disabled' }
  } else if (effort) {
    if (isGptFamily(kiroModel)) fields.reasoning = { effort }
    else fields.output_config = { effort }
  }

  if (maxTokens !== undefined) {
    const ceiling = getCatalogCapabilities(kiroModel)?.maxOutputTokens
    fields.max_tokens = ceiling ? Math.min(maxTokens, ceiling) : maxTokens
  }

  return Object.keys(fields).length > 0 ? fields : undefined
}

/**
 * A cache checkpoint for the tools list, or null when caching is off.
 *
 * The service advertises prompt caching per model — `supportsPromptCaching`,
 * with a minimum prompt size and a checkpoint budget — and `cachePoint` sits
 * beside `toolSpecification` in the tool union, so a checkpoint is appended to
 * the tools rather than placed in the message.
 *
 * Unverified on the wire, which is why this is opt-in. The Kiro CLI never
 * sends one, not even on a prompt well past the minimum, and every response it
 * gets back reports no cached tokens at all — so there is no working example
 * to copy, and a wrong shape fails the whole request.
 */
export function buildToolCachePoint(kiroModel: string, enabled: boolean): unknown | null {
  if (!enabled) return null
  if (getCatalogCapabilities(kiroModel)?.supportsCaching === false) return null
  return { cachePoint: { type: 'default' } }
}
