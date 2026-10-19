import type { Effort } from './config/schema.js'
import { getCatalogCapabilities } from './models.js'
import { RequestFieldsProfile } from './request-fields-profile.js'

/** The dial position that actually stops the model reasoning. */
export const EFFORT_OFF = 'off' as const

/**
 * The `additionalModelRequestFields` block, as the service names its members.
 *
 * The outer key is camelCase and everything inside it stays snake_case — that
 * is what the Kiro CLI puts on the wire, and the service reads it literally.
 */
export interface AdditionalModelRequestFields {
  /** Effort channel for models whose schema has output_config. */
  output_config?: { effort: Effort }
  /** Effort channel for models whose schema has reasoning; `none` only where the enum lists it. */
  reasoning?: { effort: Effort | 'none' }
  /** Adaptive is the default. 'between_tools' is in the enum but the
   *  endpoint 400s on it, so this plugin never emits it. */
  thinking?: { type: 'adaptive' | 'disabled' | 'between_tools' }
  max_tokens?: number
}

/** Builds one request's block from what the model's profile accepts. */
export class RequestFieldsBuilder {
  constructor(private readonly profile: RequestFieldsProfile) {}

  build(
    effort: Effort | undefined,
    thinkingDisabled: boolean,
    maxTokens?: number
  ): AdditionalModelRequestFields | undefined {
    // A model without a schema rejects the block outright: a 400 before a token.
    if (!this.profile.acceptsBlock) return undefined

    const fields: AdditionalModelRequestFields = {}
    if (thinkingDisabled) {
      Object.assign(fields, this.offFields())
    } else if (effort) {
      Object.assign(fields, this.effortFields(effort))
    }

    if (maxTokens !== undefined && this.profile.maxTokensCeiling !== undefined) {
      fields.max_tokens = Math.min(maxTokens, this.profile.maxTokensCeiling)
    }

    return Object.keys(fields).length > 0 ? fields : undefined
  }

  private offFields(): AdditionalModelRequestFields {
    if (this.profile.channel === 'output_config' && this.profile.offChannel === 'disabled') {
      return { thinking: { type: 'disabled' }, output_config: { effort: 'high' } }
    }
    if (this.profile.channel === 'reasoning' && this.profile.offChannel === 'none') {
      return { reasoning: { effort: 'none' } }
    }
    // No confirmed off channel: leave the block off instead of guessing a 400.
    return {}
  }

  private effortFields(effort: Effort): AdditionalModelRequestFields {
    // The service reads one channel or the other, never both.
    return this.profile.channel === 'reasoning'
      ? { reasoning: { effort } }
      : { output_config: { effort } }
  }
}

/** Build the block for one request, or undefined when nothing needs saying. */
export function buildModelRequestFields(
  kiroModel: string,
  effort: Effort | undefined,
  thinkingDisabled: boolean,
  maxTokens?: number
): AdditionalModelRequestFields | undefined {
  return new RequestFieldsBuilder(RequestFieldsProfile.forModel(kiroModel)).build(
    effort,
    thinkingDisabled,
    maxTokens
  )
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
