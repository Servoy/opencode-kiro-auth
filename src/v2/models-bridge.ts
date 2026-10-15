import { buildModelRegistry } from '../plugin/model-registry.js'
import type { V2ModelInfo, V2ProviderInfo } from './types.js'

/**
 * Runtime package OpenCode uses for an OpenAI-compatible provider. The plugin
 * still intercepts every request through the http hooks, so this only drives
 * URL construction and the AI SDK selection. Overridable in case a host build
 * names the package differently.
 */
const DEFAULT_PROVIDER_PACKAGE = '@opencode-ai/ai/providers/openai-compatible'

interface V1RegistryModel {
  name: string
  limit: { context: number; output: number }
  modalities: { input: Array<'text' | 'image' | 'pdf'>; output: ['text'] }
  temperature?: boolean
  reasoning?: boolean
  interleaved?: { field: string }
  variants?: Record<string, unknown>
}

export interface V2ProviderResult {
  info: V2ProviderInfo
  models: V2ModelInfo[]
}

/**
 * Map a v1 registry entry to a v2 `Model.Info`; the schemas disagree on field
 * names, so this is a translation rather than a spread.
 *
 * Reasoning names its wire field via `compatibility`: `Model.Capabilities` is
 * only `{tools, input, output}`, so a reasoning flag placed there is discarded.
 */
function toV2Model(providerID: string, modelID: string, entry: V1RegistryModel): V2ModelInfo {
  const variants = entry.variants
    ? Object.entries(entry.variants).map(([id, settings]) => ({
        id,
        settings: settings as Record<string, unknown>
      }))
    : []

  // Kiro streams thinking under `reasoning_content`, not the OpenAI `reasoning`
  // the host would otherwise assume from the compatible driver.
  const compatibility = entry.reasoning === true ? { reasoningField: 'reasoning_content' } : {}

  return {
    id: modelID,
    modelID,
    providerID,
    name: entry.name,
    capabilities: {
      tools: true,
      input: entry.modalities.input,
      output: entry.modalities.output
    },
    compatibility,
    variants,
    time: { released: 0 },
    cost: [],
    status: 'active' as const,
    enabled: true,
    limit: { context: entry.limit.context, output: entry.limit.output }
  }
}

/**
 * Build the v2 provider + model definitions from the same registry the v1
 * config hook uses, so both hosts advertise an identical model set. `baseURL`
 * is where OpenCode points the OpenAI-compatible client; the http hook
 * intercepts those requests before they leave the process.
 */
export function buildV2Provider(
  providerID: string,
  baseURL: string,
  quotaSuffix: string,
  providerPackage: string = DEFAULT_PROVIDER_PACKAGE
): V2ProviderResult {
  const registry = buildModelRegistry(quotaSuffix)

  const models = Object.entries(registry).map(([modelID, model]) =>
    toV2Model(providerID, modelID, model as V1RegistryModel)
  )

  return {
    info: {
      id: providerID,
      name: 'Kiro',
      activation: 'auto',
      package: providerPackage,
      // Ties the provider to the integration that signs in for it, so the host
      // can attribute the credential rather than treating them as unrelated.
      integrationID: providerID,
      settings: { baseURL }
    },
    models
  }
}
