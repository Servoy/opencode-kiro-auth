import { GenerateAssistantResponseCommand } from '@aws/codewhisperer-streaming-client'
import type { AccountRepository } from '../../infrastructure/database/account-repository'
import { isPermanentlyUnusable, isUsableAccount } from '../../plugin/account-usability'
import type { AccountManager } from '../../plugin/accounts'
import type { KiroConfig } from '../../plugin/config'
import type { Effort } from '../../plugin/config/schema'
import { isPermanentError } from '../../plugin/health'
import { imageCache } from '../../plugin/image-cache'
import * as logger from '../../plugin/logger'
import { refreshModelCatalog } from '../../plugin/models'
import { transformToSdkRequest } from '../../plugin/request'
import { readRequestOptions } from '../../plugin/request-options'
import { createSdkClient } from '../../plugin/sdk-client'
import { kiroDb } from '../../plugin/storage/sqlite'
import { syncFromKiroCli } from '../../plugin/sync/kiro-cli'
import type { KiroAuthDetails, ManagedAccount, SdkPreparedRequest } from '../../plugin/types'
import { AccountSelector } from '../account/account-selector'
import { UsageTracker } from '../account/usage-tracker'
import { IdcAuthMethod } from '../auth/idc-auth-method.js'
import { TokenRefresher } from '../auth/token-refresher'
import { ErrorHandler } from './error-handler'
import { ResponseHandler } from './response-handler'
import { RetryStrategy } from './retry-strategy'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

// Matches both the standard q.amazonaws.com endpoint and the Pro runtime.kiro.dev endpoint
const KIRO_API_PATTERN =
  /^(https?:\/\/)?(q\.[a-z0-9-]+\.amazonaws\.com|runtime\.[a-z0-9-]+\.kiro\.dev)/
const REAUTH_BASE_COOLDOWN_MS = 5_000
const REAUTH_MAX_COOLDOWN_MS = 60_000
const REAUTH_MIN_WAIT_MS = 120_000
const REAUTH_MAX_WAIT_MS = 600_000

/**
 * How long to wait for a browser sign-in, clamped to [2min, 10min].
 *
 * Waiting less than the device code's own lifetime guarantees a timeout for
 * anyone typing a password plus an MFA code, and each timeout issues a fresh
 * code and opens another browser tab.
 */
export function reauthWaitMs(deviceCodeExpiresInSeconds: number | undefined): number {
  const deviceCodeMs = (deviceCodeExpiresInSeconds ?? 0) * 1000
  return Math.min(REAUTH_MAX_WAIT_MS, Math.max(REAUTH_MIN_WAIT_MS, deviceCodeMs))
}

const CONTEXT_LENGTH_REASONS = new Set(['CONTENT_LENGTH_EXCEEDS_THRESHOLD', 'PROMPT_TOO_LONG'])

function validationReason(error: any): string {
  const reason = error?.reason
  return typeof reason === 'string' ? reason : ''
}

function isContextLengthError(reason: string, message: string): boolean {
  if (CONTEXT_LENGTH_REASONS.has(reason)) return true
  return /content length exceeds threshold|input is too long|prompt is too long|too many tokens/i.test(
    message
  )
}

/** OpenAI-shaped 400 so the host compacts the session instead of failing. */
function contextLengthResponse(message: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: message || 'input is too long for requested model',
        type: 'invalid_request_error',
        code: 'context_length_exceeded'
      }
    }),
    { status: 400, headers: { 'Content-Type': 'application/json' } }
  )
}

const passthroughHostsLogged = new Set<string>()
const MAX_PASSTHROUGH_HOSTS_LOGGED = 5

/**
 * Record a host this plugin declines to handle, once each and capped.
 *
 * Without it, "never called" and "called and succeeded" both leave the log
 * empty, which makes a runaway agent loop impossible to place.
 */
function logPassthrough(url: string): void {
  let host: string
  try {
    host = new URL(url).host
  } catch {
    host = url.slice(0, 80)
  }
  if (passthroughHostsLogged.has(host)) return
  if (passthroughHostsLogged.size >= MAX_PASSTHROUGH_HOSTS_LOGGED) return
  passthroughHostsLogged.add(host)
  logger.warn(`Kiro fetch passthrough: ${host} is not a Kiro endpoint, forwarding unhandled`)
}

/**
 * Everything OpenCode sends, minus the bulk.
 *
 * Messages, tools and the system prompt are summarised rather than printed —
 * they are the payload, and the question this answers is what OpenCode says
 * *about* a request: which variant was chosen, what options ride along, which
 * headers arrive. A setting that never shows up here was never sent.
 */
function logIncomingRequest(body: any, init: any): void {
  const BULK = new Set(['messages', 'tools', 'system', 'prompt'])
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body ?? {})) {
    if (!BULK.has(key)) rest[key] = value
  }

  // The shape of the tail is what tells you whether a turn is a tool loop or a
  // fresh question; the first hundred of a long conversation are just noise.
  const allRoles = Array.isArray(body?.messages)
    ? body.messages.map((m: any) => String(m?.role ?? '?')[0]).join('')
    : ''
  const roles = allRoles.length > 40 ? `…${allRoles.slice(-40)}` : allRoles

  logger.debug(
    `[IN] messages=${body?.messages?.length ?? 0}(${roles}) tools=${body?.tools?.length ?? 0}` +
      ` systemChars=${typeof body?.system === 'string' ? body.system.length : 0}` +
      ` rest=${JSON.stringify(rest)}` +
      ` headers=${JSON.stringify(init?.headers ?? null)}`
  )
}

function extractSessionId(headers: unknown): string | undefined {
  if (!headers) return undefined
  const h = headers as Record<string, string>
  return h['x-session-id'] ?? h['x-session-affinity']
}

export class RequestHandler {
  private accountSelector: AccountSelector
  private tokenRefresher: TokenRefresher
  private errorHandler: ErrorHandler
  private responseHandler: ResponseHandler
  private usageTracker: UsageTracker
  private retryStrategy: RetryStrategy
  private reauthInFlight: Promise<boolean> | null = null
  private lastFailedReauthAt = 0
  private reauthFailureStreak = 0
  /** One lane per account: different accounts must not wait on each other. */
  private static kiroRequestQueues = new Map<string, Promise<void>>()
  /** Requests in flight right now, so the log can show whether work overlapped. */
  private static inFlight = 0

  constructor(
    private accountManager: AccountManager,
    private config: KiroConfig,
    private repository: AccountRepository,
    private client?: any,
    private workspace = ''
  ) {
    this.accountSelector = new AccountSelector(accountManager, config, syncFromKiroCli, repository)
    this.tokenRefresher = new TokenRefresher(config, accountManager, syncFromKiroCli, repository)
    this.errorHandler = new ErrorHandler(config, accountManager)
    this.responseHandler = new ResponseHandler()
    this.usageTracker = new UsageTracker(config, accountManager, repository)
    this.retryStrategy = new RetryStrategy(config)
  }

  async handle(input: any, init: any, showToast: ToastFunction): Promise<Response> {
    const url = typeof input === 'string' ? input : input.url

    if (!KIRO_API_PATTERN.test(url)) {
      logPassthrough(url)
      return fetch(input, init)
    }

    const sessionId = extractSessionId(init?.headers)

    // Queue only matters when multiple accounts share rate limits.
    if (this.accountManager.getAccountCount() <= 1) {
      return this.handleKiroRequest(url, init, showToast, sessionId)
    }

    return this.enqueueKiroRequest(this.queueLane(sessionId), () =>
      this.handleKiroRequest(url, init, showToast, sessionId)
    )
  }

  /**
   * The lane a request queues in: the account that will serve it.
   *
   * Session affinity already decided that, so the lane is known before the
   * account is selected. A session on its first turn has no account yet and
   * shares one lane, which is the rare case.
   */
  private queueLane(sessionId?: string): string {
    if (!sessionId) return 'unpinned'
    try {
      // A session has no account until its first turn has been served. Putting
      // those in one lane made a fan-out of fresh subagents run one at a time,
      // which is the case the lanes exist for — so an unpinned session is its
      // own lane, and joins its account's lane once it has one.
      const accountId = kiroDb.getSessionAccount(sessionId)
      return accountId ? `acc:${accountId}` : `new:${sessionId}`
    } catch {
      return `new:${sessionId}`
    }
  }

  /**
   * Run one request at a time per account, so they share their rate limits.
   *
   * Serialising every request instead made two sessions on two accounts wait
   * on each other, which is the opposite of what a second account is for — a
   * fan-out of subagents ran end to end rather than side by side.
   *
   * The wait on the predecessor is bounded: ordering is a courtesy, and a
   * request that never settles must not wedge every later one in the process.
   */
  private async enqueueKiroRequest<T>(lane: string, run: () => Promise<T>): Promise<T> {
    const previous = RequestHandler.kiroRequestQueues.get(lane) ?? Promise.resolve()
    let release!: () => void

    const mine = new Promise<void>((resolve) => {
      release = resolve
    })
    RequestHandler.kiroRequestQueues.set(lane, mine)

    const queueStart = Date.now()
    const waited = await this.raceWithTimeout(
      previous.catch(() => {}),
      this.queueWaitMs()
    )
    const queuedMs = Date.now() - queueStart
    if (!waited) {
      logger.warn(
        `Kiro request queue: predecessor still running after ${Math.round(this.queueWaitMs() / 1000)}s, proceeding in parallel`
      )
    } else if (queuedMs > 100) {
      logger.debug(`[QUEUE] lane=${lane} waited=${queuedMs}ms`)
    }

    try {
      return await run()
    } finally {
      release()
      // Drop the lane once nothing is behind us, so the map tracks live work
      // rather than every account ever used.
      if (RequestHandler.kiroRequestQueues.get(lane) === mine) {
        RequestHandler.kiroRequestQueues.delete(lane)
      }
    }
  }

  private queueWaitMs(): number {
    return Math.max(30_000, this.config.request_timeout_ms || 120_000)
  }

  /** True when the promise settled first, false when the timeout won. */
  private raceWithTimeout(promise: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
      promise.then(
        () => true,
        () => true
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms)
      })
    ]).finally(() => clearTimeout(timer))
  }

  private async handleKiroRequest(
    url: string,
    init: any,
    showToast: ToastFunction,
    sessionId?: string
  ): Promise<Response> {
    // Counted around the whole request, not each retry, and released however
    // it ends — a counter that only comes down on success climbs forever.
    RequestHandler.inFlight++
    const concurrent = RequestHandler.inFlight
    try {
      return await this.runKiroRequest(url, init, showToast, sessionId, concurrent)
    } finally {
      RequestHandler.inFlight--
    }
  }

  private async runKiroRequest(
    url: string,
    init: any,
    showToast: ToastFunction,
    sessionId: string | undefined,
    concurrent: number
  ): Promise<Response> {
    const body = init?.body ? JSON.parse(init.body) : {}
    logIncomingRequest(body, init)
    const model = this.extractModel(url) || body.model || 'claude-sonnet-4-5'

    // Read where OpenCode actually puts them; see request-options.ts.
    const { requestedEffort, thinkingDisabled, think, maxTokens, budget } = readRequestOptions(
      body,
      model
    )
    let retry = 0
    let bearerRetried = false
    let consecutiveNullAccounts = 0
    let forceNewConversation = false
    const retryContext = this.retryStrategy.createContext()

    while (true) {
      const check = this.retryStrategy.shouldContinue(retryContext)
      if (!check.canContinue) {
        throw new Error(check.error)
      }

      if (this.allAccountsPermanentlyUnhealthy()) {
        const reauthed = await this.triggerReauth(showToast)
        if (!reauthed) {
          throw new Error('All accounts are permanently unhealthy. Please re-authenticate.')
        }
        continue
      }

      let acc = await this.accountSelector
        .selectHealthyAccount(showToast, sessionId)
        .catch(async (e) => {
          if (e instanceof Error && e.message.includes('reauth required')) {
            const reauthed = await this.triggerReauth(showToast)
            if (!reauthed)
              throw new Error('All accounts are unhealthy or rate-limited. Please re-authenticate.')
            return null
          }
          throw e
        })
      if (!acc) {
        consecutiveNullAccounts++
        const backoffDelay = Math.min(1000 * Math.pow(2, consecutiveNullAccounts - 1), 10000)
        await this.sleep(backoffDelay)
        continue
      }

      consecutiveNullAccounts = 0
      const tSelected = Date.now()
      const auth = this.accountManager.toAuthDetails(acc)

      const tokenResult = await this.tokenRefresher.refreshIfNeeded(acc, auth, showToast)
      if (tokenResult.shouldContinue) {
        acc = tokenResult.account
        await this.sleep(500)
        continue
      }

      // Not awaited: this only sharpens a token estimate, and no request
      // should wait on it. Cached, so it runs at most once every five minutes.
      // If discovery hits a stale token it forces a refresh once — the same
      // recovery the request below does — instead of logging a failure.
      void refreshModelCatalog(auth, () => this.recoverAuthForCatalog(acc))

      const tAuthed = Date.now()
      const sdkPrep = this.prepareSdkRequest(
        body,
        model,
        auth,
        think,
        budget,
        showToast,
        sessionId,
        thinkingDisabled,
        maxTokens,
        requestedEffort
      )
      const tPrepared = Date.now()

      const histLen = (sdkPrep.conversationState as any).history?.length || 0
      const agentContId = (sdkPrep.conversationState as any).agentContinuationId || 'none'
      logger.debug(
        `[REQ] convId=${sdkPrep.conversationId} history=${histLen} agentCont=${agentContId} model=${model} effort=${sdkPrep.effort ?? 'none'}`
      )

      // Attachments are the thing you most need to see when a model claims it
      // cannot find an image, so this rides on trace rather than on the much
      // heavier full request log.
      this.logImageDiagnostic(sdkPrep)

      const apiTimestamp = this.config.enable_log_api_request ? logger.getTimestamp() : null
      if (apiTimestamp) {
        this.logSdkRequest(sdkPrep, acc, apiTimestamp)
      }

      try {
        const client = createSdkClient(
          auth,
          sdkPrep.region,
          sdkPrep.modelRequestFields,
          this.config.request_timeout_ms
        )
        const command = new GenerateAssistantResponseCommand({
          conversationState: sdkPrep.conversationState as any,
          profileArn: sdkPrep.profileArn
        })

        const sdkResponse = await client.send(command)
        const tUpstream = Date.now()
        // The SDK retries throttling and transient failures on its own, with
        // backoff, and says so only here. Without it a request that was
        // retried twice is indistinguishable from one Kiro simply took a long
        // time over — the difference between our problem and theirs.
        const meta = (
          sdkResponse as { $metadata?: { attempts?: number; totalRetryDelay?: number } }
        ).$metadata

        if (apiTimestamp) {
          this.logSdkResponse(sdkPrep, apiTimestamp)
        }

        if (bearerRetried) {
          logger.warn(`bearer retry succeeded convId=${sdkPrep.conversationId}`)
        }

        this.handleSuccessfulRequest(acc)
        this.recordSessionRequest(sessionId, acc.id)
        this.usageTracker.syncUsage(acc, auth)

        const result = await this.responseHandler.handleSdkSuccess(
          sdkResponse,
          model,
          sdkPrep.conversationId,
          sdkPrep.streaming,
          sdkPrep.toolNameMap
        )
        // Which side is slow is otherwise unanswerable. `upstream` is the wait
        // for Kiro to start answering and dominates everything else; `handoff`
        // is wrapping its stream, not reading it, since generation continues
        // after this returns.
        const done = Date.now()
        logger.debug(
          `[TIMING] convId=${sdkPrep.conversationId} auth=${tAuthed - tSelected}ms` +
            ` prep=${tPrepared - tAuthed}ms upstream=${tUpstream - tPrepared}ms` +
            ` handoff=${done - tUpstream}ms inFlight=${concurrent}` +
            ` attempts=${meta?.attempts ?? 1} retryDelay=${meta?.totalRetryDelay ?? 0}ms`
        )
        logger.debug(`[REQ] done convId=${sdkPrep.conversationId}`)
        return result
      } catch (e: any) {
        logger.warn(
          `[REQ] error convId=${sdkPrep.conversationId}: ${e?.name || ''} ${e?.message?.slice(0, 200) || String(e).slice(0, 200)}`
        )
        const httpStatus = e?.$metadata?.httpStatusCode

        if (httpStatus && apiTimestamp) {
          this.logSdkError(sdkPrep, e, acc, apiTimestamp)
        }

        if (httpStatus === 403 && !bearerRetried) {
          const msg = e?.message || ''
          if (
            msg.includes('bearer token included in the request is invalid') ||
            msg.includes('The bearer token included in the request is invalid')
          ) {
            bearerRetried = true
            logger.warn('403 bearer invalid on first attempt, forcing token refresh and retrying')
            const refreshed = await this.tokenRefresher.forceRefresh(
              acc,
              this.accountManager.toAuthDetails(acc)
            )
            if (!refreshed) {
              logger.warn(
                `bearer-403 refresh failed, rotating/reauth convId=${sdkPrep.conversationId}`
              )
              bearerRetried = false
            }
            continue
          }
        }

        if (httpStatus === 403 && bearerRetried) {
          logger.warn(
            `bearer retry failed: still 403 after token refresh convId=${sdkPrep.conversationId}`
          )
        }

        if (httpStatus === 400) {
          const reason = validationReason(e)
          const message = e?.message || ''

          if (isContextLengthError(reason, message)) {
            logger.warn(
              `[REQ] payload rejected as too large (${reason || 'no reason'}) convId=${sdkPrep.conversationId} history=${histLen}`
            )
            showToast('Kiro rejected the request as too large — compact the session.', 'warning')
            return contextLengthResponse(message)
          }

          // Resetting on any ValidationException discards the conversation
          // mapping and carried-forward images for nothing.
          const staleConversation =
            reason === 'INVALID_CONVERSATION_ID' ||
            (!reason && e?.name === 'ValidationException' && /conversation/i.test(message))

          if (staleConversation && !forceNewConversation) {
            const { workspace, fingerprint } = sdkPrep.conversationKey
            kiroDb.deleteConversationId(workspace, fingerprint)
            imageCache.delete(workspace, fingerprint)
            logger.warn(
              `[REQ] stale conversationId reset, retrying convId=${sdkPrep.conversationId}`
            )
            forceNewConversation = true
            continue
          }
        }

        if (httpStatus) {
          const mockResponse = new Response(
            JSON.stringify({ message: e.message, __type: e.name }),
            {
              status: httpStatus,
              statusText: e.name || 'Error',
              headers: { 'Content-Type': 'application/json' }
            }
          )

          const errorResult = await this.errorHandler.handle(
            e,
            mockResponse,
            acc,
            { retry, bearerRetried, excludedMs: retryContext.excludedMs },
            showToast,
            model
          )

          if (errorResult.shouldRetry) {
            if (errorResult.newContext) {
              retry = errorResult.newContext.retry
              bearerRetried = errorResult.newContext.bearerRetried ?? bearerRetried
              const sleptMs = (errorResult.newContext.excludedMs ?? 0) - retryContext.excludedMs
              if (sleptMs > 0) this.retryStrategy.markSleep(retryContext, sleptMs)
            }
            if (errorResult.forceRefresh) {
              await this.tokenRefresher.forceRefresh(acc, this.accountManager.toAuthDetails(acc))
            }
            if (errorResult.switchAccount) {
              retry = 0
              bearerRetried = false
              consecutiveNullAccounts = 0
              continue
            }
            continue
          }

          if (this.allAccountsPermanentlyUnhealthy()) {
            const reauthed = await this.triggerReauth(showToast)
            if (reauthed) continue
          }

          throw new Error(`Kiro Error: ${httpStatus}`)
        }

        const networkResult = await this.errorHandler.handleNetworkError(e, { retry }, showToast)

        if (networkResult.shouldRetry) {
          if (networkResult.newContext) {
            retry = networkResult.newContext.retry
          }
          continue
        }

        throw e
      }
    }
  }

  private extractModel(url: string): string | null {
    return url.match(/models\/([^/:]+)/)?.[1] || null
  }

  private prepareSdkRequest(
    body: any,
    model: string,
    auth: KiroAuthDetails,
    think: boolean,
    budget: number,
    showToast?: (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void,
    sessionId?: string,
    thinkingDisabled = false,
    maxTokens?: number,
    requestedEffort?: Effort
  ): SdkPreparedRequest {
    return transformToSdkRequest(
      body,
      model,
      auth,
      think,
      budget,
      showToast,
      this.workspace,
      this.config.image_carry_forward,
      sessionId,
      this.config.max_payload_bytes,
      thinkingDisabled,
      maxTokens,
      requestedEffort
    )
  }

  /**
   * Count one served request against its session for the panel's cost estimate.
   *
   * Best-effort: a store hiccup here must never fail a request that already
   * succeeded, so failures are swallowed to the log. No sessionId (a request
   * with no affinity header) is simply not attributed. `accountId` is the
   * account that served this request, so its credits are later apportioned to
   * the right account even when a session rotates across several.
   */
  private recordSessionRequest(sessionId: string | undefined, accountId: string): void {
    if (!sessionId) return
    try {
      kiroDb.recordSessionRequest(sessionId, accountId, { directory: this.workspace || undefined })
    } catch (e) {
      logger.debug(
        `[USAGE] session request not recorded: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }

  private handleSuccessfulRequest(acc: ManagedAccount): void {
    // Only write to DB if the account was actually degraded — avoids a
    // withDatabaseLock + full merge/dedup round-trip on every healthy request.
    if (acc.failCount && acc.failCount > 0 && !isPermanentError(acc.unhealthyReason)) {
      acc.failCount = 0
      acc.isHealthy = true
      delete acc.unhealthyReason
      delete acc.recoveryTime
      this.repository.save(acc).catch(() => {})
    }
  }

  private logSdkRequest(prep: SdkPreparedRequest, acc: ManagedAccount, timestamp: string): void {
    // Mirrors what the sdk-client middleware injects, so logs reflect the wire body.
    const additionalModelRequestFields = prep.modelRequestFields

    logger.logApiRequest(
      {
        url: `${prep.endpoint}/generateAssistantResponse`,
        method: 'POST',
        headers: { 'x-amzn-kiro-agent-mode': 'vibe' },
        body: {
          conversationState: {
            chatTriggerType: prep.conversationState.chatTriggerType,
            conversationId: prep.conversationState.conversationId,
            historyLength: (prep.conversationState as any).history?.length || 0,
            currentMessage: prep.conversationState.currentMessage
          },
          profileArn: prep.profileArn,
          ...(additionalModelRequestFields ? { additionalModelRequestFields } : {})
        },
        conversationId: prep.conversationId,
        model: prep.effectiveModel,
        email: acc.email
      },
      timestamp
    )
  }

  /** What attachments actually went out, on the current turn and in history. */
  private logImageDiagnostic(prep: SdkPreparedRequest): void {
    const kb = (bytes: number): number => Math.round(bytes / 1024)
    const sumBytes = (imgs: { source?: { bytes?: { byteLength?: number } } }[]): number =>
      imgs.reduce((n, im) => n + (im.source?.bytes?.byteLength ?? 0), 0)

    const uim = prep.conversationState.currentMessage?.userInputMessage as any
    const cmImgs = uim?.images ?? []
    const cmDocs = uim?.documents ?? []
    const history = (prep.conversationState as any).history ?? []
    const histDetail: string[] = []
    let histImgs = 0
    let histKb = 0
    for (let i = 0; i < history.length; i++) {
      const imgs = history[i]?.userInputMessage?.images ?? []
      if (imgs.length === 0) continue
      const entryKb = kb(sumBytes(imgs))
      histDetail.push(`i=${i}:user:${imgs.length}(${entryKb}KB)`)
      histImgs += imgs.length
      histKb += entryKb
    }

    const detail = histDetail.length ? ` detail=[${histDetail.join(',')}]` : ''
    const histDocs = history.reduce(
      (n: number, h: any) => n + (h?.userInputMessage?.documents?.length ?? 0),
      0
    )
    logger.debug(
      `[IMG] convId=${prep.conversationId} curImg=${cmImgs.length}(${kb(sumBytes(cmImgs))}KB)` +
        ` curDoc=${cmDocs.length} histImg=${histImgs}/${history.length}(${histKb}KB)` +
        ` histDoc=${histDocs}${detail}`
    )
  }

  private logSdkResponse(prep: SdkPreparedRequest, timestamp: string): void {
    logger.logApiResponse(
      {
        status: 200,
        statusText: 'OK',
        headers: {},
        conversationId: prep.conversationId,
        model: prep.effectiveModel
      },
      timestamp
    )
  }

  private logSdkError(
    prep: SdkPreparedRequest,
    error: any,
    acc: ManagedAccount,
    apiTimestamp: string
  ): void {
    const status = error?.$metadata?.httpStatusCode || 0
    const rData = {
      status,
      statusText: error?.name || 'Error',
      headers: {},
      error: `Kiro Error: ${status} - ${error?.message || 'Unknown'}`,
      conversationId: prep.conversationId,
      model: prep.effectiveModel
    }
    if (!this.config.enable_log_api_request) {
      logger.logApiError(
        {
          url: `${prep.endpoint}/generateAssistantResponse`,
          method: 'POST',
          headers: {},
          body: null,
          conversationId: prep.conversationId,
          model: prep.effectiveModel,
          email: acc.email
        },
        rData,
        logger.getTimestamp()
      )
    } else {
      logger.logApiResponse(rData, apiTimestamp)
    }
  }

  /**
   * Hand the model catalog a fresh token after it hits a stale one.
   *
   * The catalog fetch and the inference request run on the same account, so a
   * token that just expired fails both. This forces the one refresh the
   * request loop would have done anyway and returns the account's new auth to
   * retry with — or undefined when the refresh could not produce a new token,
   * so the catalog stops rather than repeats the same rejected call.
   */
  private async recoverAuthForCatalog(acc: ManagedAccount): Promise<KiroAuthDetails | undefined> {
    const refreshed = await this.tokenRefresher.forceRefresh(
      acc,
      this.accountManager.toAuthDetails(acc)
    )
    return refreshed ? this.accountManager.toAuthDetails(acc) : undefined
  }

  private async triggerReauth(showToast: ToastFunction): Promise<boolean> {
    if (!this.client) return false

    // Progressive cooldown: 5s, 10s, 20s, 40s, capped at 60s.
    if (this.reauthFailureStreak > 0) {
      const cooldown = Math.min(
        REAUTH_BASE_COOLDOWN_MS * Math.pow(2, this.reauthFailureStreak - 1),
        REAUTH_MAX_COOLDOWN_MS
      )
      const remaining = cooldown - (Date.now() - this.lastFailedReauthAt)
      if (remaining > 0) {
        showToast(
          `Re-auth cooldown ${Math.ceil(remaining / 1000)}s — plugin will retry automatically.`,
          'info'
        )
        return false
      }
    }

    if (this.reauthInFlight) {
      return this.reauthInFlight
    }

    if (!kiroDb.acquireReauthLock()) {
      logger.warn('Reauth lock held by another instance — polling for completion')
      showToast('Another session is re-authenticating. Please wait...', 'info')
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        await this.sleep(1000)
        if (kiroDb.isReauthLockHeld()) continue
        this.repository.invalidateCache()
        const accounts = await this.repository.findAll()
        for (const acc of accounts) await this.accountManager.addAccount(acc)
        if (this.hasUsableAccount(accounts)) {
          this.reauthFailureStreak = 0
          return true
        }
        return false
      }
      showToast('Another session is still re-authenticating. Retrying later.', 'info')
      return false
    }

    this.reauthInFlight = this.performReauth(showToast)
    const success = await this.reauthInFlight.finally(() => {
      this.reauthInFlight = null
      kiroDb.releaseReauthLock()
    })
    if (success) {
      this.reauthFailureStreak = 0
    } else {
      this.lastFailedReauthAt = Date.now()
      this.reauthFailureStreak++
    }
    return success
  }

  private async performReauth(showToast: ToastFunction): Promise<boolean> {
    try {
      showToast('Opening browser for Kiro authentication — complete sign-in there.', 'warning')
      logger.warn('Reauth: starting oauth flow')

      const accounts = this.accountManager.getAccounts()
      const account = accounts[0]
      const inputs: Record<string, string> = {}
      if (account) {
        if (account.profileArn) inputs.profile_arn = account.profileArn
        if (account.startUrl) inputs.start_url = account.startUrl
        if (account.oidcRegion) inputs.idc_region = account.oidcRegion
      }

      const idcMethod = new IdcAuthMethod(this.config, this.repository, this.accountManager)
      const abortController = new AbortController()
      const auth = await idcMethod.authorize(inputs, abortController.signal)

      // Log + toast the verification URL; the log is the guaranteed fallback
      // since the toast is unreliable in some hosts.
      const verificationUrl = (auth as any).url as string | undefined
      if (verificationUrl) {
        logger.warn(`Reauth: open this URL to sign in: ${verificationUrl}`)
        showToast(`Sign in to Kiro: ${verificationUrl}`, 'warning')
      }

      const waitMs = reauthWaitMs((auth as any).expiresIn)

      const withTimeout = <T>(promise: Promise<T>, label: string): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined
        return Promise.race([
          promise.finally(() => clearTimeout(timer)),
          new Promise<T>(
            (_, reject) =>
              (timer = setTimeout(() => {
                abortController.abort()
                reject(new Error(`Reauth timed out waiting for ${label}`))
              }, waitMs))
          )
        ])
      }

      logger.warn(`Reauth: waiting up to ${Math.round(waitMs / 1000)}s for browser sign-in`)
      const callbackPromise = (auth as any).callback() as Promise<any>
      const result = (await withTimeout(callbackPromise, 'oauth.callback')) as any

      if (result.type !== 'success') {
        showToast('Re-authentication failed.', 'error')
        return false
      }

      this.repository.invalidateCache()
      const freshAccounts = await this.repository.findAll()
      for (const acc of freshAccounts) {
        await this.accountManager.addAccount(acc)
      }

      if (!this.hasUsableAccount(freshAccounts)) {
        logger.warn('Re-auth completed but no usable Kiro account was found')
        showToast('Re-authentication completed but no usable Kiro account was found.', 'error')
        return false
      }

      showToast('Re-authentication successful.', 'success')
      return true
    } catch (e) {
      logger.error('Re-auth failed', e instanceof Error ? e : new Error(String(e)))
      showToast(
        e instanceof Error && e.message.includes('timed out')
          ? 'Re-authentication timed out. Complete sign-in in the browser, then retry.'
          : 'Re-authentication failed. Please try again.',
        'error'
      )
      return false
    }
  }

  private hasUsableAccount(accounts: ManagedAccount[]): boolean {
    return accounts.some((acc) => isUsableAccount(acc))
  }

  private allAccountsPermanentlyUnhealthy(): boolean {
    const accounts = this.accountManager.getAccounts()
    if (accounts.length === 0) {
      return false
    }
    return accounts.every((acc) => isPermanentlyUnusable(acc))
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
