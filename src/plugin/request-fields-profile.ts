import type { Effort } from './config/schema.js'
import { EFFORT_LEVELS, supportsEffort, supportsXHighEffort } from './effort.js'
import { getCatalogCapabilities, type ModelCapabilities } from './models.js'

export type EffortChannel = 'output_config' | 'reasoning'
export type OffChannel = 'disabled' | 'none'

/**
 * What one model's additionalModelRequestFields accepts.
 *
 * The catalog schema is the authority once it has been read. The built-in
 * lists are the fallback for a cold or unreachable catalog, where they keep
 * the behaviour the plugin had before it read the schema.
 */
export class RequestFieldsProfile {
  private constructor(
    readonly channel: EffortChannel,
    readonly efforts: readonly Effort[],
    readonly offChannel: OffChannel | undefined,
    readonly acceptsBlock: boolean,
    /** Infinity means the model takes max_tokens with no ceiling of its own. */
    readonly maxTokensCeiling: number | undefined,
    private readonly clampXHighUp: boolean
  ) {}

  static forModel(kiroModel: string): RequestFieldsProfile {
    const caps = getCatalogCapabilities(kiroModel)
    return caps
      ? RequestFieldsProfile.fromCatalog(caps)
      : RequestFieldsProfile.fromBuiltIn(kiroModel)
  }

  static fromCatalog(caps: ModelCapabilities): RequestFieldsProfile {
    const advertised = caps.efforts ?? []
    const efforts = EFFORT_LEVELS.filter((level) => advertised.includes(level))
    const ceiling = caps.acceptsMaxTokens
      ? Math.min(caps.maxTokensCeiling ?? Infinity, caps.maxOutputTokens ?? Infinity)
      : undefined
    return new RequestFieldsProfile(
      caps.effortChannel ?? 'output_config',
      efforts,
      caps.thinkingOffChannel,
      caps.supportsRequestFields !== false,
      ceiling,
      false
    )
  }

  static fromBuiltIn(kiroModel: string): RequestFieldsProfile {
    const gpt = /^(gpt|openai)/i.test(kiroModel)
    const efforts = supportsEffort(kiroModel)
      ? EFFORT_LEVELS.filter((level) => level !== 'xhigh' || supportsXHighEffort(kiroModel))
      : []
    return new RequestFieldsProfile(
      gpt ? 'reasoning' : 'output_config',
      efforts,
      gpt ? 'none' : undefined,
      true,
      Infinity,
      true
    )
  }

  hasDial(): boolean {
    return this.efforts.length > 0
  }

  /** The nearest level the model accepts, or undefined when it has no dial. */
  resolveEffort(requested: Effort): Effort | undefined {
    if (this.efforts.length === 0) return undefined
    if (this.efforts.includes(requested)) return requested
    // The built-in lists keep today's xhigh-to-max rule; the catalog fits downward.
    if (this.clampXHighUp && requested === 'xhigh' && this.efforts.includes('max')) return 'max'
    const wanted = EFFORT_LEVELS.indexOf(requested)
    const below = this.efforts.filter((level) => EFFORT_LEVELS.indexOf(level) < wanted)
    return below.length > 0 ? below[below.length - 1]! : this.efforts[0]!
  }
}
