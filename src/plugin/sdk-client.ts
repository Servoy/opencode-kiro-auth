import { CodeWhispererStreamingClient } from '@aws/codewhisperer-streaming-client'
import * as crypto from 'crypto'
import { KIRO_CONSTANTS, buildUrl, extractRegionFromArn } from '../constants.js'
import { kiroHeaders } from './http-headers.js'
import type { AdditionalModelRequestFields } from './model-request-fields.js'
import type { KiroAuthDetails } from './types'

const KIRO_VERSION = '0.11.63'
const KIRO_CLI_MAX_ATTEMPTS = 3

function getMachineId(auth: KiroAuthDetails): string {
  const key = auth.profileArn || auth.email || 'default'
  return crypto.createHash('sha256').update(key).digest('hex')
}

/**
 * Resolve the correct chat endpoint for the given auth details.
 *
 * - Accounts with a profileArn (Kiro Pro / Q Developer Pro) → runtime.kiro.dev
 *   This endpoint serves all models including third-party ones (glm-5, minimax, …).
 *   It requires a profileArn on every request and returns 400 without one.
 *
 * - Accounts without a profileArn (free AWS Builder ID) → q.amazonaws.com
 *   This endpoint accepts the same token + request shape but only serves
 *   Claude-family models. Using runtime.kiro.dev here causes a 400.
 *
 * Region must match transformToSdkRequest's signing region (same fallback
 * order) — SSO home region and profile ARN region can differ for IDC accounts.
 */
export function resolveKiroEndpoint(auth: KiroAuthDetails): string {
  const region = extractRegionFromArn(auth.profileArn) ?? auth.region ?? 'us-east-1'
  if (auth.profileArn) {
    return buildUrl(KIRO_CONSTANTS.RUNTIME_URL, region as any)
  }
  return buildUrl(KIRO_CONSTANTS.BASE_URL, region as any)
}

/**
 * Cache key includes the request fields, since the middleware that injects
 * them is bound when the client is created.
 */
interface ClientCacheEntry {
  client: CodeWhispererStreamingClient
  token: string
  endpoint: string
  fieldsKey: string
}

// Per-session keying grows with every session, so the cache is LRU-bounded.
// Map preserves insertion order, so the first key is the oldest — and a session
// serialises its own requests, so the oldest entry is idle and safe to destroy.
const MAX_CACHED_CLIENTS = 32

const clientCache = new Map<string, ClientCacheEntry>()

function evictOldestClients(): void {
  while (clientCache.size > MAX_CACHED_CLIENTS) {
    const oldest = clientCache.keys().next().value
    if (oldest === undefined) return
    const entry = clientCache.get(oldest)
    clientCache.delete(oldest)
    try {
      entry?.client.destroy()
    } catch {}
  }
}

export function createSdkClient(
  auth: KiroAuthDetails,
  region: string,
  fields?: AdditionalModelRequestFields,
  requestTimeoutMs = 300_000,
  sessionId?: string
): CodeWhispererStreamingClient {
  const endpoint = resolveKiroEndpoint(auth)
  const fieldsKey = fields ? JSON.stringify(fields) : 'none'
  // endpoint + fields are in the key because the middleware binds them at
  // creation. sessionId is in the key so two sessions on one account never
  // share a client: a shared client's token refresh destroy()ed the socket the
  // other session was still streaming on — the "ECONNRESET: aborted" bug.
  const session = sessionId || 'nosession'
  const cacheKey = `${region}:${auth.email || 'default'}:${endpoint}:${fieldsKey}:${requestTimeoutMs}:${session}`
  const cached = clientCache.get(cacheKey)

  if (cached && cached.token === auth.access && cached.fieldsKey === fieldsKey) {
    return cached.client
  }

  // Token rotated (refresh) or endpoint changed — tear down the stale client
  // so its sockets/agent don't leak before we replace the cache entry.
  if (cached) {
    try {
      cached.client.destroy()
    } catch {}
  }

  const machineId = getMachineId(auth)
  const token = auth.access

  // Strip the path portion — the SDK constructs the full URL from region + endpoint.
  const endpointBase = endpoint.replace(/\/generateAssistantResponse$/, '')

  const client = new CodeWhispererStreamingClient({
    region,
    endpoint: endpointBase,
    token: () => Promise.resolve({ token }),
    maxAttempts: KIRO_CLI_MAX_ATTEMPTS,
    retryMode: 'standard',
    customUserAgent: [[`${KIRO_CONSTANTS.USER_AGENT}-${KIRO_VERSION}-${machineId}`]],
    requestHandler: {
      connectionTimeout: 10000,
      // How long Kiro may take to start answering. The timer is cleared once
      // the response headers arrive, so it does not limit how long the answer
      // itself may stream. Five minutes because the wait grows with the
      // conversation: a 300k-token history has been measured at 77s, and this
      // aborts rather than warns, so the margin has to be real.
      requestTimeout: requestTimeoutMs,
      // Without this the timeout only logs a warning and the request hangs on.
      throwOnRequestTimeout: true
    }
  })

  // Add Kiro-specific headers
  client.middlewareStack.add(
    (next: any) => async (args: any) => {
      for (const [k, v] of Object.entries(kiroHeaders(auth.profileArn))) {
        args.request.headers[k] = v
      }
      return next(args)
    },
    { step: 'build', name: 'addKiroHeaders' }
  )

  // Inject additionalModelRequestFields — the reasoning channel, the off
  // switch and the output ceiling all travel in this one block.
  if (fields) {
    client.middlewareStack.add(
      (next: any) => async (args: any) => {
        // The SDK serializes input to args.input, we need to modify the body
        // before it's sent. The body is in args.request.body as a string.
        if (args.request?.body) {
          try {
            const body = JSON.parse(args.request.body)
            body.additionalModelRequestFields = fields
            args.request.body = JSON.stringify(body)
          } catch {
            // If body parsing fails, continue without modification
          }
        }
        return next(args)
      },
      { step: 'build', name: 'addEffortConfig', priority: 'high' }
    )
  }

  // Re-set on an existing key must move it to the newest slot, or the LRU
  // sweep below could evict the entry we just refreshed.
  clientCache.delete(cacheKey)
  clientCache.set(cacheKey, { client, token, endpoint, fieldsKey })
  evictOldestClients()
  registerProcessCleanup()
  return client
}

/**
 * Close everything we hold when the process is winding down.
 *
 * OpenCode never calls the plugin's dispose hook — it has not fired once in
 * any log — so the cleanup there has never run, and an open client with live
 * sockets is left for the process to sort out. `beforeExit` fires when the
 * loop would otherwise be done, which is the moment to let go.
 *
 * Registered once per process, not once per project: OpenCode loads a separate
 * copy of this module for every open project, and 26 listeners on one signal
 * is its own problem.
 */
const CLEANUP_REGISTERED = Symbol.for('kiro.sdkClientCleanupRegistered')

function registerProcessCleanup(): void {
  const g = globalThis as Record<symbol, unknown>
  if (g[CLEANUP_REGISTERED]) return
  g[CLEANUP_REGISTERED] = true
  process.once('beforeExit', () => {
    try {
      clearSdkClientCache()
    } catch {
      // Nothing useful left to do while the process is on its way out.
    }
  })
}

export function clearSdkClientCache(): void {
  for (const entry of clientCache.values()) {
    entry.client.destroy()
  }
  clientCache.clear()
}
