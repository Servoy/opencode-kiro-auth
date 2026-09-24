import { KIRO_CONSTANTS } from '../constants.js'
import { AuthHandler } from '../core/auth/auth-handler.js'
import { RequestHandler } from '../core/request/request-handler.js'
import { AccountCache } from '../infrastructure/database/account-cache.js'
import { AccountRepository } from '../infrastructure/database/account-repository.js'
import { AccountManager } from '../plugin/accounts.js'
import { loadConfig } from '../plugin/config/index.js'
import { imageCache } from '../plugin/image-cache.js'
import * as logger from '../plugin/logger.js'
import { refreshModelCatalog, subscribeCatalogUpdated } from '../plugin/models.js'
import { clearSdkClientCache } from '../plugin/sdk-client.js'
import { kiroDb } from '../plugin/storage/sqlite.js'
import { noopToast, type ToastFn } from '../plugin/toast.js'
import { buildWebSearchToolV2 } from '../plugin/web-search.js'
import { buildIntegrationMethods } from './integration.js'
import { buildV2Provider } from './models-bridge.js'
import { createRequestBridge } from './request-bridge.js'
import type { V2Cleanup, V2Context, V2Registration, V2SessionHttpResponse } from './types.js'

/**
 * v2 entrypoint factory. Reuses the v1 core (AccountManager, AuthHandler,
 * RequestHandler, model registry) and binds it to v2 domain transforms and
 * session hooks instead of the v1 auth/provider/fetch hooks.
 *
 * Route A (http hooks): every provider request flows through the
 * `http.response` hook, which swaps in the RequestHandler's streaming Response
 * for Kiro endpoints and leaves every other provider untouched.
 */
export function createV2Setup(id: string) {
  return async (ctx: V2Context): Promise<V2Cleanup> => {
    const config = loadConfig(ctx.location.directory)
    logger.setDebugEnabled(config.trace === true)
    logger.log(`Kiro v2 plugin init: configDir resolved, directory=${ctx.location.directory}`)

    // The v2 host toast surface is not wired yet; the log is the guaranteed
    // sink, matching how the v1 branch degrades when a host has no TUI.
    const toast: ToastFn = noopToast

    const cache = new AccountCache(60000)
    const repository = new AccountRepository(cache)
    const authHandler = new AuthHandler(config, repository)
    const accountManager = await AccountManager.loadFromDisk(config.account_selection_strategy)
    authHandler.setAccountManager(accountManager)
    await authHandler.initialize(toast)

    const requestHandler = new RequestHandler(
      accountManager,
      config,
      repository,
      undefined,
      ctx.location.directory
    )

    const baseURL = KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '').replace(
      '{{region}}',
      config.default_region || 'us-east-1'
    )

    const registrations: V2Registration[] = []

    await ctx.integration.transform((editor) => {
      editor.update(id, (integration) => {
        integration.name = 'Kiro'
      })
      for (const registration of buildIntegrationMethods(id, authHandler.getMethods() as never)) {
        editor.method.update(registration)
      }
    })
    await ctx.integration.reload()

    // Read the account's real context windows before registering models, so the
    // advertised limit is the catalog's from the first request. Best-effort: a
    // cold or unreachable catalog leaves the built-in windows in place, and the
    // reload below corrects them once the first request populates the catalog.
    const account = accountManager.getCurrentOrNext()
    if (account) {
      await refreshModelCatalog(accountManager.toAuthDetails(account)).catch(() => {})
    }

    const quota = ''
    const { info, models } = buildV2Provider(id, baseURL, quota)
    registrations.push(
      await ctx.provider.transform((editor) => {
        editor.add({ info, models })
      })
    )

    // Register kiro_web_search for v2 hosts. v1 hosts use the v1 tool() helper
    // inside buildTools(); v2 hosts register via ctx.tool.transform with the
    // v2 Tool.Info shape. Same description and behavior either way — only the
    // registration mechanism differs. Returns null when no Pro account is
    // available, which the host then skips silently.
    const webSearchTool = buildWebSearchToolV2(accountManager)
    if (webSearchTool) {
      registrations.push(
        await ctx.tool.transform((editor) => {
          editor.add(webSearchTool as never)
        })
      )
    }

    const bridge = createRequestBridge(requestHandler, toast)

    registrations.push(await ctx.session.hook('http.request', () => {}))
    registrations.push(
      await ctx.session.hook('http.response', async (event: V2SessionHttpResponse) => {
        const url = event.request?.url ?? ''
        if (!bridge.isKiroUrl(url)) return
        const body = event.request.body ? await event.request.clone().text() : undefined
        const headers: Record<string, string> = {}
        event.request.headers.forEach((value, key) => {
          headers[key] = value
        })
        event.response = await bridge.handleRequest(url, { body, headers })
      })
    )

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const _event of ctx.event.subscribe({ signal: controller.signal })) {
          // Event-driven parity (usage refresh, live quota suffix) is a
          // follow-up; the v1 branch keeps that behaviour today.
        }
      } catch {
        // Subscription aborts on cleanup; nothing to recover.
      }
    })()

    // When the catalog populates (live fetch on the first request, or stored
    // restore in a second project), re-register the provider with the now
    // catalog-aware windows so the host re-renders model limits. Best-effort:
    // a reload that throws must not break the running session.
    const unsubscribeCatalog = subscribeCatalogUpdated(() => {
      ctx.provider
        .reload()
        .catch((e: unknown) =>
          logger.debug(`[V2] provider reload after catalog update failed: ${String(e)}`)
        )
      ctx.model
        .reload()
        .catch((e: unknown) =>
          logger.debug(`[V2] model reload after catalog update failed: ${String(e)}`)
        )
    })

    return async () => {
      controller.abort()
      unsubscribeCatalog()
      for (const registration of registrations) {
        await registration.dispose().catch(() => {})
      }
      try {
        clearSdkClientCache()
      } catch {
        /* best effort */
      }
      try {
        imageCache.clear()
      } catch {
        /* best effort */
      }
      try {
        // kiroDb.close() is a no-op under WAL — closing the shared
        // connection raced with sibling queries. The advisory locks held
        // at shutdown are still released so the next start isn't blocked.
        kiroDb.close()
      } catch {
        /* best effort */
      }
      logger.debug('[DISPOSE] Kiro v2 plugin shutdown complete')
    }
  }
}
