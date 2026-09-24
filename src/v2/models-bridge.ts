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
 * Map a v1 registry entry to a v2 `Model.Info`. The two schemas disagree on
 * several field names, so this is an explicit translation rather than a spread:
 * v1 `modalities.{input,output}` become `capabilities.{input,output}` (with a
 * `tools` flag v2 requires), the v1 `variants` object becomes a v2 array of
 * `{ id, settings }`, and v2's mandatory `time`/`cost`/`status`/`enabled`
 * fields are supplied. Reasoning capability rides `capabilities.reasoning`.
 */
function toV2Model(providerID: string, modelID: string, entry: V1RegistryModel): V2ModelInfo {
  const variants = entry.variants
    ? Object.entries(entry.variants).map(([id, settings]) => ({
        id,
        settings: settings as Record<string, unknown>
      }))
    : []

  return {
    id: modelID,
    modelID,
    providerID,
    name: entry.name,
    capabilities: {
      tools: true,
      reasoning: entry.reasoning === true,
      temperature: entry.temperature === true,
      input: entry.modalities.input,
      output: entry.modalities.output
    },
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
      settings: { baseURL }
    },
    models
  }
}
