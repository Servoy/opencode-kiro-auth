import { KIRO_CONSTANTS, MODEL_MAPPING, SUPPORTED_MODELS } from '../constants'
import { kiroHeaders } from './http-headers.js'
import * as logger from './logger'
import { kiroDb } from './storage/sqlite'
import type { KiroAuthDetails } from './types'

export function resolveKiroModel(model: string): string {
  const resolved = MODEL_MAPPING[model]
  if (!resolved) {
    throw new Error(`Unsupported model: ${model}. Supported models: ${SUPPORTED_MODELS.join(', ')}`)
  }
  return resolved
}

/**
 * Shape of the stored catalog. Bump it whenever ModelCapabilities gains a
 * field: a row written before that field existed reads it back as undefined,
 * which is not the same as the service having said no — and a plugin that
 * cannot tell those apart acts on an answer nobody gave.
 */
const CATALOG_VERSION = 2
const VERSION_KEY = '__catalogVersion'

const CATALOG_TTL_MS = 30 * 60 * 1000
/** A failed lookup is retried sooner than a good one is refreshed, but not on
 *  every request: an unreachable catalog must not become a request per call. */
const CATALOG_RETRY_MS = 5 * 60 * 1000

/**
 * What the service says a model can do, as ListAvailableModels reports it.
 *
 * Every field is optional: the catalog omits what does not apply, and a model
 * absent from it keeps whatever the built-in table says.
 */
export interface ModelCapabilities {
  maxInputTokens?: number
  maxOutputTokens?: number
  rateMultiplier?: number
  /** Lowercased input modalities, e.g. ['text', 'image']. */
  inputTypes?: string[]
  /** Effort levels the model accepts, in the order the service lists them. */
  efforts?: string[]
  supportsThinking?: boolean
  /** Whether the model accepts an additionalModelRequestFields block at all. */
  supportsRequestFields?: boolean
  supportsCaching?: boolean
  /** Smallest prompt worth a cache checkpoint, and how many fit in a request. */
  minCacheTokens?: number
  maxCacheCheckpoints?: number
}

let catalogByKiroModel: Map<string, ModelCapabilities> | null = null
let catalogAttemptedAt = 0
let catalogTtl = CATALOG_TTL_MS
let catalogKey = ''
let catalogInFlight: Promise<void> | null = null

/** Limits are per account and per region, so a catalog belongs to one of each. */
function accountKey(auth: KiroAuthDetails): string {
  return `${auth.region}:${auth.profileArn ?? ''}`
}

/**
 * Context window the service reports for a model, if it has been discovered.
 *
 * Returns undefined until {@link refreshModelCatalog} has succeeded, so callers
 * keep their own default rather than guessing at a limit.
 */
export function getCatalogContextLimit(model: string): number | undefined {
  return capabilitiesFor(model)?.maxInputTokens
}

/**
 * Everything the catalog knows about a model, or undefined before it is read.
 *
 * Callers keep their built-in answer when this returns nothing, so a cold or
 * unreachable catalog never removes a model's capabilities — it only corrects
 * them once the service has been asked.
 */
export function getCatalogCapabilities(model: string): ModelCapabilities | undefined {
  return capabilitiesFor(model)
}

function capabilitiesFor(model: string): ModelCapabilities | undefined {
  if (!catalogByKiroModel) return undefined
  const alias = model.endsWith('-thinking') ? model.slice(0, -'-thinking'.length) : model
  const kiroModel = MODEL_MAPPING[alias] ?? alias
  return catalogByKiroModel.get(kiroModel)
}

/**
 * Fetch each model's real context window from the account's own catalog.
 *
 * The catalog lives on the control plane (management.<region>.kiro.dev), not
 * the inference endpoint, and is an awsJson1_0 RPC rather than a REST call —
 * verified against what the Kiro CLI itself sends. Context windows
 * change a few times a year, so the answer is held for half an hour — but a
 * different account or region refetches immediately, since those limits are
 * theirs and not the previous account's. Failures leave the previous answer in
 * place.
 */
export async function refreshModelCatalog(auth: KiroAuthDetails): Promise<void> {
  const key = accountKey(auth)
  if (Date.now() - catalogAttemptedAt < catalogTtl && key === catalogKey) return
  if (catalogInFlight) return catalogInFlight

  // Another project may already have asked. The catalog lives in kiro.db
  // precisely because OpenCode gives each project its own module instance.
  const stored = readStoredCatalog(key)
  if (stored) return

  catalogInFlight = (async () => {
    try {
      const url = new URL(`https://management.${auth.region}.kiro.dev/`)
      url.searchParams.set('origin', KIRO_CONSTANTS.ORIGIN_AI_EDITOR)
      if (auth.profileArn) url.searchParams.set('profileArn', auth.profileArn)

      const payload: Record<string, string> = { origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR }
      if (auth.profileArn) payload.profileArn = auth.profileArn

      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.access}`,
          'Content-Type': 'application/x-amz-json-1.0',
          'X-Amz-Target': 'AmazonCodeWhispererService.ListAvailableModels',
          ...kiroHeaders(auth.profileArn)
        },
        body: JSON.stringify(payload)
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`ListAvailableModels failed: ${res.status} ${detail.slice(0, 300)}`)
      }

      const data: any = await res.json()
      const models = Array.isArray(data?.models) ? data.models : []
      const discovered = new Map<string, ModelCapabilities>()

      for (const entry of models) {
        const id = entry?.modelId || entry?.modelName || entry?.id
        if (typeof id !== 'string') continue
        discovered.set(id, readCapabilities(entry))
      }

      if (discovered.size === 0) throw new Error('ListAvailableModels returned no models')

      const changes = describeChanges(discovered)
      catalogByKiroModel = discovered
      catalogAttemptedAt = Date.now()
      catalogTtl = CATALOG_TTL_MS
      catalogKey = key
      persist(key, discovered, catalogAttemptedAt, CATALOG_TTL_MS)
      if (changes.length > 0) {
        logger.log('Model catalog: context windows discovered', { changes })
      }
    } catch (e) {
      catalogAttemptedAt = Date.now()
      catalogTtl = CATALOG_RETRY_MS
      catalogKey = key
      // Only back off in the shared store if there is something to back off
      // with. kiro.db is shared by every project on the machine, so writing an
      // empty map over a good row — which is what a cold start whose first
      // fetch fails used to do — left all of them with no catalog for five
      // minutes. With no catalog, a model that rejects additionalModel-
      // RequestFields is sent it again and answers 400.
      if (catalogByKiroModel && catalogByKiroModel.size > 0) {
        persist(key, catalogByKiroModel, catalogAttemptedAt, CATALOG_RETRY_MS)
      }
      logger.warn('Model catalog: discovery failed, keeping the built-in limits', {
        error: e instanceof Error ? e.message : String(e)
      })
    } finally {
      catalogInFlight = null
    }
  })()

  return catalogInFlight
}

/**
 * Adopt a catalog another project already fetched, when it is still fresh.
 *
 * Returns true when the caller can skip the network entirely.
 */
function readStoredCatalog(key: string): boolean {
  let row
  try {
    row = kiroDb.getModelCatalog(key)
  } catch {
    return false
  }
  if (!row || Date.now() - row.attemptedAt >= row.ttlMs) return false

  // Rows written before the catalog held more than a context window stored a
  // bare number; read them as the one field they carried.
  if (row.models[VERSION_KEY] !== CATALOG_VERSION) return false

  const entries: Array<[string, ModelCapabilities]> = Object.entries(row.models)
    .filter(([model]) => model !== VERSION_KEY)
    .map(([model, value]) => [model, (value ?? {}) as ModelCapabilities])

  // A row carrying no models answers nothing, so it must not count as an
  // answer: saying otherwise short-circuits the fetch that would have got one.
  if (entries.length === 0) return false

  catalogByKiroModel = new Map(entries)
  catalogAttemptedAt = row.attemptedAt
  catalogTtl = row.ttlMs
  catalogKey = key
  return true
}

function persist(
  key: string,
  models: Map<string, ModelCapabilities>,
  attemptedAt: number,
  ttlMs: number
): void {
  try {
    const stored: Record<string, unknown> = Object.fromEntries(models)
    stored[VERSION_KEY] = CATALOG_VERSION
    kiroDb.setModelCatalog(key, stored, attemptedAt, ttlMs)
  } catch (e) {
    logger.debug(`Model catalog: could not persist (${e instanceof Error ? e.message : e})`)
  }
}

/**
 * Read one catalog entry.
 *
 * The effort levels live in the JSON Schema the service advertises for
 * additionalModelRequestFields, which is also where it says whether a model
 * takes a thinking block at all — a model without that schema has no dial,
 * whatever a built-in list claims.
 */
function readCapabilities(entry: any): ModelCapabilities {
  const caps: ModelCapabilities = {}

  const maxIn = entry?.tokenLimits?.maxInputTokens
  const maxOut = entry?.tokenLimits?.maxOutputTokens
  if (typeof maxIn === 'number' && maxIn > 0) caps.maxInputTokens = maxIn
  if (typeof maxOut === 'number' && maxOut > 0) caps.maxOutputTokens = maxOut
  if (typeof entry?.rateMultiplier === 'number') caps.rateMultiplier = entry.rateMultiplier

  if (Array.isArray(entry?.supportedInputTypes)) {
    caps.inputTypes = entry.supportedInputTypes
      .filter((t: unknown) => typeof t === 'string')
      .map((t: string) => t.toLowerCase())
  }

  const caching = entry?.promptCaching
  if (caching && typeof caching.supportsPromptCaching === 'boolean') {
    caps.supportsCaching = caching.supportsPromptCaching
    if (typeof caching.minimumTokensPerCacheCheckpoint === 'number') {
      caps.minCacheTokens = caching.minimumTokensPerCacheCheckpoint
    }
    if (typeof caching.maximumCacheCheckpointsPerRequest === 'number') {
      caps.maxCacheCheckpoints = caching.maximumCacheCheckpointsPerRequest
    }
  }

  // Set either way, never left undefined: a model that advertises no schema
  // rejects the whole block, and a model missing from the catalog has to keep
  // receiving one, so the two cases must be distinguishable.
  caps.supportsRequestFields = !!entry?.additionalModelRequestFieldsSchema

  const schema = entry?.additionalModelRequestFieldsSchema?.properties
  const efforts =
    schema?.output_config?.properties?.effort?.enum ?? schema?.reasoning?.properties?.effort?.enum
  if (Array.isArray(efforts)) {
    caps.efforts = efforts.filter((e: unknown) => typeof e === 'string')
  }
  if (schema?.thinking) caps.supportsThinking = true

  return caps
}

function describeChanges(discovered: Map<string, ModelCapabilities>): string[] {
  const previous = catalogByKiroModel
  const changes: string[] = []
  for (const [model, caps] of discovered) {
    const before = previous?.get(model)
    if (JSON.stringify(before) !== JSON.stringify(caps)) {
      changes.push(`${model}=${caps.maxInputTokens ?? '?'}/${(caps.efforts ?? []).length}eff`)
    }
  }
  return changes
}

/** Test-only: drop only the in-process copy, as a fresh project would see it. */
export function resetMemoryOnly(): void {
  catalogByKiroModel = null
  catalogAttemptedAt = 0
  catalogTtl = CATALOG_TTL_MS
  catalogKey = ''
  catalogInFlight = null
}

/** Test-only: drop the cached catalog so the next refresh refetches. */
export function resetModelCatalog(): void {
  try {
    kiroDb.deleteModelCatalog()
  } catch {
    // The store is optional; an unavailable database just means no sharing.
  }
  catalogByKiroModel = null
  catalogAttemptedAt = 0
  catalogTtl = CATALOG_TTL_MS
  catalogKey = ''
  catalogInFlight = null
}
