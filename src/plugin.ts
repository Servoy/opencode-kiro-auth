import { tool } from '@opencode-ai/plugin'
import { createRequire } from 'node:module'
import { KIRO_CONSTANTS } from './constants.js'
import { AuthHandler } from './core/auth/auth-handler.js'
import { RequestHandler } from './core/request/request-handler.js'
import { AccountCache } from './infrastructure/database/account-cache.js'
import { AccountRepository } from './infrastructure/database/account-repository.js'
import { AccountManager } from './plugin/accounts.js'
import { bootstrapAuthIfNeeded } from './plugin/auth-bootstrap.js'
import { loadConfig } from './plugin/config/index.js'
import { getConfigDir } from './plugin/config/paths.js'
import { imageCache } from './plugin/image-cache.js'
import * as logger from './plugin/logger.js'
import { buildModelRegistry } from './plugin/model-registry.js'
import { clearSdkClientCache } from './plugin/sdk-client.js'
import { kiroDb } from './plugin/storage/sqlite.js'
import { summarizeUsage } from './plugin/usage.js'
import { formatWebSearchResults, kiroWebSearch } from './plugin/web-search.js'

type ToastFunction = (message: string, variant: string) => void

const KIRO_PROVIDER_ID = 'kiro'

/**
 * Quota marker for the model picker, e.g. "· 13%".
 *
 * Returns an empty string when no account reports a limit, so a model name is
 * never decorated with a number nobody can act on.
 */
/**
 * The models object OpenCode was handed, kept so the quota in each name can be
 * refreshed in place.
 *
 * The registry is built once, in the config hook, and the percentage baked
 * into every name froze there — it still read 13% after a morning's work took
 * it to 14.5%. Whether OpenCode re-reads these names or snapshots them is its
 * own business; updating the object we gave it is the only offer we can make.
 */
let installedModels: Record<string, unknown> | null = null
let installedSuffix = ''

function refreshQuotaInModelNames(accountManager: AccountManager): void {
  if (!installedModels) return
  const suffix = usageSuffix(accountManager)
  if (!suffix || suffix === installedSuffix) return

  for (const model of Object.values(installedModels)) {
    const entry = model as { name?: string }
    if (typeof entry.name !== 'string') continue
    entry.name = installedSuffix
      ? entry.name.replace(installedSuffix, suffix)
      : `${entry.name} ${suffix}`
  }
  logger.debug(`[MODELS] quota suffix updated ${installedSuffix || '(none)'} -> ${suffix}`)
  installedSuffix = suffix
}

function usageSuffix(accountManager: AccountManager): string {
  const account = accountManager.getAccounts().find((a) => (a.limitCount ?? 0) > 0)
  if (!account) return ''
  const { pct } = summarizeUsage(account.usedCount ?? 0, account.limitCount ?? 0)
  return `· ${pct}%`
}

// Read once at module load: confirms which published version is actually
// running, since the plugin loader can silently keep a stale cached install.
const PLUGIN_VERSION: string = (() => {
  try {
    const require = createRequire(import.meta.url)
    return require('../package.json').version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()

// Register Kiro's server-side web search as a custom tool, when enabled and the
// active account is Pro (has a profileArn). Returns an empty object otherwise so
// nothing is advertised to the model on free accounts.
//
// The description is adapted from Kiro's own web_search tool spec so the model
// gets the same guidance on when to search and how to attribute results.
const WEB_SEARCH_DESCRIPTION = `Search the web using Kiro's built-in search engine. Returns titles, URLs, snippets, domains, and publish dates for a query. Billed as Kiro credits.

## When to Use
- The user asks for current or up-to-date information (pricing, versions, release notes, recent events, library APIs).
- Verifying facts that may have changed recently, or details likely newer than the model's training data.
- Looking up specifics of a library, framework, or tool that can't be reliably inferred from the codebase or context.

## When NOT to Use
- Basic concepts, historical facts, or well-established programming syntax the model already knows.
- Anything answerable from the current repository, files, or conversation. Search the codebase first.

## Query Tips
- Keep queries focused; the query MUST be 200 characters or fewer (longer queries are rejected).
- Rephrase the user's request into effective keywords. Run multiple focused searches for complex questions rather than one broad query.
- The snippets often contain enough to answer directly; only fetch a full page (via a separate fetch tool) when you need more detail.

## Using Results & Attribution
- Prioritize the most recently published, authoritative sources (prefer official docs over blogs; use the domain to judge authority).
- ALWAYS cite sources with inline links in the format [description](url).
- Paraphrase and summarize; do not reproduce more than ~30 consecutive words verbatim from any single source. Preserve factual accuracy while condensing.`

function buildTools(config: any, accountManager: AccountManager): Record<string, any> {
  if (!config.web_search_enabled) return {}
  const account = accountManager.getCurrentOrNext()
  if (!account?.profileArn) return {}

  return {
    kiro_web_search: tool({
      description: WEB_SEARCH_DESCRIPTION,
      args: {
        query: tool.schema.string().describe('The search query. Must be 200 characters or fewer.')
      },
      async execute(args: { query: string }) {
        try {
          const results = await kiroWebSearch(accountManager, args.query)
          return formatWebSearchResults(results)
        } catch (e) {
          return `Web search failed: ${e instanceof Error ? e.message : String(e)}`
        }
      }
    })
  }
}

export const createKiroPlugin =
  (id: string) =>
  async ({ client, directory }: any) => {
    logger.log(`Kiro plugin init: version=${PLUGIN_VERSION} configDir=${getConfigDir()}`)
    const config = loadConfig(directory)
    logger.setDebugEnabled(config.trace === true)

    const showToast: ToastFunction = (message: string, variant: string) => {
      // Flat params, not a `body` wrapper — the SDK maps message/variant at the top level.
      // Hosts without a TUI drop toasts silently, leaving the log as the only
      // trace of the failure.
      client.tui.showToast({ message, variant: variant as any }).catch((e: unknown) => {
        logger.warn('showToast failed; message only reached the log', {
          variant,
          message,
          error: e instanceof Error ? e.message : String(e)
        })
      })
    }

    const cache = new AccountCache(60000)
    const repository = new AccountRepository(cache)

    const authHandler = new AuthHandler(config, repository)
    const accountManager = await AccountManager.loadFromDisk(config.account_selection_strategy)
    authHandler.setAccountManager(accountManager)

    const requestHandler = new RequestHandler(accountManager, config, repository, client, directory)

    // Compute the base URL once so both the config hook and auth loader use the same value
    const baseURL = KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '').replace(
      '{{region}}',
      config.default_region || 'us-east-1'
    )

    return {
      config: async (input: any) => {
        // Ensure there's an auth entry so OpenCode calls the loader on startup.
        // This is a no-op if the entry already exists.
        bootstrapAuthIfNeeded(id)

        if (!input.provider) input.provider = {}
        if (!input.provider[id]) input.provider[id] = {}
        // Always set npm and api — these must be present regardless of whether
        // the user has already defined the provider in their opencode.json.
        input.provider[id].npm = '@ai-sdk/openai-compatible'
        // Set the base URL at the provider level. OpenCode reads provider.api as
        // model.api.url, which resolveSDK() uses to construct the endpoint URL.
        // Only set if not already overridden by the user.
        if (!input.provider[id].api) {
          input.provider[id].api = baseURL
        }
        if (!input.provider[id].models) {
          const quota = config.show_usage_in_model_name === true ? usageSuffix(accountManager) : ''
          logger.debug(`[MODELS] registry built, quota suffix=${quota || 'off'}`)
          const models = buildModelRegistry(quota)
          input.provider[id].models = models
          if (config.show_usage_in_model_name === true) {
            installedModels = models
            installedSuffix = quota
          }
        }
      },
      auth: {
        provider: id,
        loader: async (getAuth: any) => {
          await getAuth()
          await authHandler.initialize(showToast as any)

          return {
            apiKey: '',
            // Provide baseURL explicitly so the @ai-sdk/openai-compatible provider
            // always has a valid URL. The custom fetch below intercepts all Kiro
            // API calls, so this value is only used for URL construction.
            baseURL,
            fetch: async (input: any, init?: any) => {
              const response = await requestHandler.handle(input, init, showToast)
              // The usage tracker refreshes on its own cooldown; this is simply
              // the next moment we are running after it may have done so.
              refreshQuotaInModelNames(accountManager)
              return response
            }
          }
        },
        methods: authHandler.getMethods()
      },
      provider: {
        id,
        models: async (provider: any) => {
          const models = provider?.models || {}
          const normalized: Record<string, any> = {}

          for (const [modelID, model] of Object.entries(models)) {
            const modelInfo = model as any
            normalized[modelID] = {
              ...modelInfo,
              api: {
                ...(modelInfo.api || {}),
                npm: '@ai-sdk/openai-compatible',
                // Ensure url is always set. modelInfo.api.url should already be
                // populated from the config hook's provider.api field, but we
                // set it explicitly as a fallback for any edge cases.
                url: modelInfo.api?.url || baseURL
              }
            }
          }

          return normalized
        }
      },
      tool: buildTools(config, accountManager),
      dispose: async () => {
        logger.debug('[DISPOSE] Kiro plugin shutting down')
        try {
          clearSdkClientCache()
        } catch {}
        try {
          imageCache.clear()
        } catch {}
        try {
          kiroDb.close()
        } catch {}
        logger.debug('[DISPOSE] Kiro plugin shutdown complete')
      }
    }
  }

export const KiroOAuthPlugin = createKiroPlugin(KIRO_PROVIDER_ID)
