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

    const fields = thinkingDisabled ? this.offFields() : effort ? this.effortFields(effort) : {}

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

/**
 * Whether this model can be told not to reason, or undefined when nobody knows.
 *
 * `thinking: {type: "disabled"}` genuinely stops reasoning, so a schema with no
 * disable value cannot be switched off at all — Opus 5.5 offers `["adaptive"]`
 * alone. Undefined means the catalog was never read, which is not the same as no.
 *
 * Read from the request-fields profile rather than the model name: the profile
 * already resolves the off channel from the catalog schema (or the built-in
 * lists while it is cold), so `offChannel` defined means a confirmed way to
 * switch off, and a model that takes no block at all has nothing to switch off.
 */
export function canDisableThinking(kiroModel: string): boolean | undefined {
  const caps = getCatalogCapabilities(kiroModel)
  const profile = RequestFieldsProfile.forModel(kiroModel)
  // A model with no reasoning block has nothing running to switch off.
  if (!profile.acceptsBlock) return true
  // No catalog read yet: the built-in profile stands in, but it cannot prove a
  // model's schema lacks an off channel, so say nothing rather than guess no.
  if (!caps) return profile.offChannel !== undefined ? true : undefined
  return profile.offChannel !== undefined
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
