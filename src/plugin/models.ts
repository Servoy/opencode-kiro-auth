import { MODEL_MAPPING, SUPPORTED_MODELS } from '../constants'
import * as logger from './logger'
import type { KiroAuthDetails } from './types'

export function resolveKiroModel(model: string): string {
  const resolved = MODEL_MAPPING[model]
  if (!resolved) {
    throw new Error(`Unsupported model: ${model}. Supported models: ${SUPPORTED_MODELS.join(', ')}`)
  }
  return resolved
}

const CATALOG_TTL_MS = 30 * 60 * 1000

let catalogByKiroModel: Map<string, number> | null = null
let catalogFetchedAt = 0
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
  if (!catalogByKiroModel) return undefined
  const alias = model.endsWith('-thinking') ? model.slice(0, -'-thinking'.length) : model
  const kiroModel = MODEL_MAPPING[alias]
  return kiroModel ? catalogByKiroModel.get(kiroModel) : undefined
}

/**
 * Fetch each model's real context window from the account's own catalog.
 *
 * Kiro serves account-specific limits, and what it advertises publicly has not
 * always matched what it serves, so ask rather than hardcode. Context windows
 * change a few times a year, so the answer is held for half an hour — but a
 * different account or region refetches immediately, since those limits are
 * theirs and not the previous account's. Failures leave the previous answer in
 * place.
 */
export async function refreshModelCatalog(auth: KiroAuthDetails): Promise<void> {
  const key = accountKey(auth)
  const fresh = Date.now() - catalogFetchedAt < CATALOG_TTL_MS
  if (fresh && key === catalogKey) return
  if (catalogInFlight) return catalogInFlight

  catalogInFlight = (async () => {
    try {
      const url = `https://q.${auth.region}.amazonaws.com/ListAvailableModels?origin=AI_EDITOR`
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${auth.access}`,
          'Content-Type': 'application/json',
          'x-amzn-kiro-agent-mode': 'vibe'
        }
      })
      if (!res.ok) throw new Error(`ListAvailableModels failed: ${res.status}`)

      const data: any = await res.json()
      const models = Array.isArray(data?.models) ? data.models : []
      const discovered = new Map<string, number>()

      for (const entry of models) {
        const id = entry?.modelId || entry?.modelName || entry?.id
        const max = entry?.tokenLimits?.maxInputTokens
        if (typeof id === 'string' && typeof max === 'number' && max > 0) {
          discovered.set(id, max)
        }
      }

      if (discovered.size === 0) throw new Error('ListAvailableModels returned no token limits')

      const changes = describeChanges(discovered)
      catalogByKiroModel = discovered
      catalogFetchedAt = Date.now()
      catalogKey = key
      if (changes.length > 0) {
        logger.log('Model catalog: context windows discovered', { changes })
      }
    } catch (e) {
      logger.warn('Model catalog: discovery failed, keeping the built-in limits', {
        error: e instanceof Error ? e.message : String(e)
      })
    } finally {
      catalogInFlight = null
    }
  })()

  return catalogInFlight
}

function describeChanges(discovered: Map<string, number>): string[] {
  const previous = catalogByKiroModel
  const changes: string[] = []
  for (const [model, limit] of discovered) {
    const before = previous?.get(model)
    if (before !== limit) changes.push(`${model}=${limit}`)
  }
  return changes
}

/** Test-only: drop the cached catalog so the next refresh refetches. */
export function resetModelCatalog(): void {
  catalogByKiroModel = null
  catalogFetchedAt = 0
  catalogKey = ''
  catalogInFlight = null
}
