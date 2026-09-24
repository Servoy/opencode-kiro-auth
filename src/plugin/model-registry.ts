import type { Effort } from './config/schema.js'
import { EFFORT_LEVELS, supportsEffort, supportsXHighEffort } from './effort.js'
import { EFFORT_OFF } from './model-request-fields.js'
import { getCatalogCapabilities, getCatalogContextLimit, resolveKiroModel } from './models.js'

type Modalities = {
  input: Array<'text' | 'image' | 'pdf'>
  output: ['text']
}

const TEXT_ONLY: Modalities = { input: ['text'], output: ['text'] }
const TEXT_IMAGE: Modalities = { input: ['text', 'image'], output: ['text'] }
const MULTIMODAL: Modalities = { input: ['text', 'image', 'pdf'], output: ['text'] }

const CONTEXT_200K = { context: 200000, output: 64000 }
const CONTEXT_1M = { context: 1000000, output: 64000 }
const CONTEXT_1M_128K_OUT = { context: 1000000, output: 128000 }

interface ModelSpec {
  /** Display name, without the credit multiplier suffix. */
  name: string
  /** Kiro credit multiplier, rendered into the display name. */
  rate: string
  limit: { context: number; output: number }
  modalities: Modalities
  /**
   * Emit a companion `-thinking` entry. Only set for Claude models that accept
   * `output_config.effort`; the effort ladder is derived from the model's own
   * capabilities in effort.ts.
   */
  thinking?: boolean
}

/**
 * Models Kiro exposes, keyed by the OpenCode-facing model ID.
 *
 * Anthropic and open-weight models only. Kiro's GPT-5.6 tiers are deliberately
 * absent: they configure reasoning through `reasoning.effort` / `reasoning.mode`
 * rather than `output_config.effort`, so they need their own request path.
 */
export const MODEL_SPECS: Record<string, ModelSpec> = {
  auto: { name: 'Auto', rate: '1.0x', limit: CONTEXT_1M, modalities: MULTIMODAL },

  // Claude Sonnet
  'claude-sonnet-4': {
    name: 'Claude Sonnet 4.0',
    rate: '1.3x',
    limit: CONTEXT_200K,
    modalities: MULTIMODAL
  },
  'claude-sonnet-4-5': {
    name: 'Claude Sonnet 4.5',
    rate: '1.3x',
    limit: CONTEXT_200K,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-sonnet-4-6': {
    name: 'Claude Sonnet 4.6',
    rate: '1.3x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-sonnet-5': {
    name: 'Claude Sonnet 5',
    rate: '1.3x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },

  // Claude Haiku
  'claude-haiku-4-5': {
    name: 'Claude Haiku 4.5',
    rate: '0.4x',
    limit: CONTEXT_200K,
    modalities: TEXT_IMAGE
  },

  // Claude Opus
  'claude-opus-4-5': {
    name: 'Claude Opus 4.5',
    rate: '2.2x',
    limit: CONTEXT_200K,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-opus-4-6': {
    name: 'Claude Opus 4.6',
    rate: '2.2x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-opus-4-7': {
    name: 'Claude Opus 4.7',
    rate: '2.2x',
    limit: CONTEXT_1M_128K_OUT,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-opus-4-8': {
    name: 'Claude Opus 4.8',
    rate: '2.2x',
    limit: CONTEXT_1M_128K_OUT,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-opus-5': {
    name: 'Claude Opus 5',
    rate: '2.2x',
    limit: CONTEXT_1M_128K_OUT,
    modalities: MULTIMODAL,
    thinking: true
  },

  // Open weight models
  'deepseek-3.2': {
    name: 'DeepSeek 3.2',
    rate: '0.25x',
    limit: { context: 128000, output: 64000 },
    modalities: TEXT_ONLY
  },
  'glm-5': { name: 'GLM-5', rate: '0.5x', limit: CONTEXT_200K, modalities: TEXT_ONLY },
  'minimax-m2.5': {
    name: 'MiniMax M2.5',
    rate: '0.25x',
    limit: { context: 196000, output: 64000 },
    modalities: TEXT_ONLY
  },
  'minimax-m2.1': {
    name: 'MiniMax M2.1',
    rate: '0.15x',
    limit: { context: 196000, output: 64000 },
    modalities: TEXT_ONLY
  },
  'qwen3-coder-next': {
    name: 'Qwen3 Coder Next',
    rate: '0.05x',
    limit: { context: 256000, output: 64000 },
    modalities: TEXT_ONLY
  }
}

/**
 * Context limit for a model.
 *
 * Prefers the window the account's own catalog reports, falling back to
 * MODEL_SPECS. `-thinking` ids share their base's limit. The registry and the
 * streaming transformers both call this, so they can't disagree.
 */
export function getModelContextLimit(model: string): number {
  const discovered = getCatalogContextLimit(model)
  if (discovered !== undefined) return discovered

  const base = model.endsWith('-thinking') ? model.slice(0, -'-thinking'.length) : model
  return (
    MODEL_SPECS[base]?.limit.context ?? MODEL_SPECS[model]?.limit.context ?? CONTEXT_200K.context
  )
}

/**
 * The effort levels a model offers.
 *
 * The catalog is the authority — it names them per model in the schema it
 * advertises, and it disagrees with the built-in lists: opus-4.5 and sonnet-4
 * carry no schema at all, so offering them a dial advertises something the
 * service will reject. The built-in lists stand in only until the catalog has
 * been read, since the registry is built before the first request.
 */
function effortLevelsFor(kiroModel: string): readonly Effort[] | null {
  const advertised = getCatalogCapabilities(kiroModel)?.efforts
  if (advertised) {
    const known = EFFORT_LEVELS.filter((level) => advertised.includes(level))
    return known.length > 0 ? known : null
  }
  if (!supportsEffort(kiroModel)) return null
  return EFFORT_LEVELS.filter((level) => level !== 'xhigh' || supportsXHighEffort(kiroModel))
}

/**
 * Variants for a model's dial, `off` first.
 *
 * Choosing no variant is not off: the service then applies its own default,
 * which the catalog reports as `high`. Off has to be asked for, and it rides
 * on the same dial so it reads as the bottom of one scale.
 */
function buildVariants(levels: readonly Effort[], canDisable: boolean): Record<string, unknown> {
  const variants: Record<string, unknown> = {}
  if (canDisable) variants[EFFORT_OFF] = { reasoningEffort: EFFORT_OFF }
  for (const level of levels) variants[level] = { reasoningEffort: level }
  return variants
}

/**
 * Whether the model takes `thinking.type = disabled`.
 *
 * Only the catalog knows; before it is read, assume a model with a dial can
 * also be turned off, which is true of every Claude model the service lists.
 */
function canDisableThinking(kiroModel: string): boolean {
  return getCatalogCapabilities(kiroModel)?.supportsThinking ?? true
}

/**
 * Input modalities the catalog reports, falling back to the built-in table.
 *
 * The catalog omits `pdf` from supportedInputTypes even though the plugin
 * uploads documents through the service's DocumentBlock. Keep the built-in
 * `pdf` so OpenCode does not drop the attachment before it reaches the plugin.
 */
function modalitiesFor(kiroModel: string, fallback: Modalities): Modalities {
  const inputTypes = getCatalogCapabilities(kiroModel)?.inputTypes
  if (!inputTypes || inputTypes.length === 0) return fallback

  const input = [...inputTypes] as Modalities['input']
  if (fallback.input.includes('pdf') && !input.includes('pdf')) input.push('pdf')
  return { input, output: ['text'] }
}

/**
 * Model registry advertised to OpenCode.
 *
 * One entry per model. How hard a model thinks is a variant on it, not a
 * second model: the `-thinking` twins each model used to carry became an
 * exact duplicate once the effort dial moved onto the plain entry. They stay
 * resolvable in MODEL_MAPPING so a config still naming one keeps working.
 *
 * A model that offers the dial declares `reasoning` and `interleaved`. Both
 * are required: `reasoning` declares the capability, and `interleaved.field`
 * tells OpenCode that reasoning arrives in the non-standard `reasoning_content`
 * delta this plugin emits (see streaming/openai-converter.ts). Without them
 * OpenCode silently drops every chunk and no thinking block is rendered.
 */
export function buildModelRegistry(nameSuffix = ''): Record<string, unknown> {
  const models: Record<string, unknown> = {}
  const suffix = nameSuffix ? ` ${nameSuffix}` : ''

  for (const [modelID, spec] of Object.entries(MODEL_SPECS)) {
    // Effort capability is keyed on the resolved Kiro model ID, not the
    // OpenCode-facing one (e.g. claude-opus-5 vs claude-opus-4-6).
    const kiroModel = resolveKiroModel(modelID)
    const levels = effortLevelsFor(kiroModel)

    const base: Record<string, unknown> = {
      name: `${spec.name} (${spec.rate})${suffix}`,
      // Context window is the catalog's when known, the built-in spec's until
      // then — the same source getModelContextLimit uses, so the window
      // advertised to OpenCode and the one the token counter divides by can
      // never disagree (a mismatch is what showed >100% context on a turn).
      // Output stays the spec's: the catalog reports input limits only.
      limit: { context: getModelContextLimit(modelID), output: spec.limit.output },
      modalities: modalitiesFor(kiroModel, spec.modalities),
      // CodeWhisperer has no temperature field, so a configured value is
      // silently discarded. Saying so stops OpenCode offering a dead control.
      temperature: false
    }
    // A model with an effort dial reasons as soon as a variant is picked, so it
    // has to declare the capability — without `reasoning` and `interleaved`
    // OpenCode drops every chunk and the thinking block never renders.
    if (levels) {
      base.reasoning = true
      base.interleaved = { field: 'reasoning_content' }
      base.variants = buildVariants(levels, canDisableThinking(kiroModel))
    }
    models[modelID] = base
  }

  return models
}
