import { createHash } from 'node:crypto'
import { extractRegionFromArn, KIRO_CONSTANTS, KIRO_SERVICE_REGIONS } from '../../constants.js'
import type { AccountRepository } from '../../infrastructure/database/account-repository.js'
import { createDeterministicAccountId } from '../../plugin/accounts.js'
import { describeError } from '../../plugin/describe-error.js'
import { kiroHeaders } from '../../plugin/http-headers.js'
import * as logger from '../../plugin/logger.js'
import { redactSecrets } from '../../plugin/redact.js'
import { makePlaceholderEmail } from '../../plugin/sync/kiro-cli-parser.js'
import type { KiroRegion, ManagedAccount } from '../../plugin/types.js'
import { fetchUsageLimits } from '../../plugin/usage.js'

export const API_KEY_PATTERN = /^ksk_[A-Za-z0-9_-]{16,}$/

/** What the host stores for a key-based sign-in: the real key stays in kiro.db. */
const MANAGED_KEY = 'kiro-managed'

/** The configured key: KIRO_API_KEY wins over kiro.json's api_key. */
export function configuredApiKey(config: { api_key?: string }): string | undefined {
  return process.env.KIRO_API_KEY?.trim() || config.api_key?.trim() || undefined
}

/** A masked hint for a prompt placeholder — never the whole key. */
export function maskApiKey(key: string): string {
  return `ksk_…${key.length > 4 ? key.slice(-4) : ''}`
}

export class ApiKeyAuthMethod {
  constructor(
    private config: { default_region?: KiroRegion; api_key?: string },
    private repository: AccountRepository,
    private accountManager?: any
  ) {}

  async authorize(inputs?: Record<string, string>): Promise<{ type: 'success'; key: string }> {
    // A typed key is validated as-is; only a blank field falls back to the
    // configured key, so a wrong paste is never masked by it.
    const typed = (inputs?.api_key ?? '').trim()
    const key = typed || (configuredApiKey(this.config) ?? '')
    if (!API_KEY_PATTERN.test(key)) {
      throw new Error('Enter a Kiro API key starting with ksk_')
    }

    const defaultRegion = this.config.default_region ?? KIRO_CONSTANTS.DEFAULT_REGION
    const profileArn = await this.resolveProfileArn(key, defaultRegion)
    const region = extractRegionFromArn(profileArn) ?? defaultRegion

    // Usage is metadata, not a login gate — a failed lookup must never discard a valid key.
    const usage = await fetchUsageLimits({
      refresh: '',
      access: key,
      expires: 0,
      authMethod: 'apikey',
      region,
      profileArn
    }).catch((e) => {
      logger.warn('fetchUsageLimits failed during API key sign-in; continuing with zeroed usage', {
        error: redactSecrets(describeError(e))
      })
      return { usedCount: 0, limitCount: 0, email: undefined }
    })

    const email = usage.email || makePlaceholderEmail('apikey', region, undefined, profileArn)
    const acc: ManagedAccount = {
      id: createDeterministicAccountId(email, 'apikey', undefined, profileArn),
      email,
      authMethod: 'apikey',
      region,
      profileArn,
      // Fingerprint, not the key: the stable per-key identity the dedup folds on.
      refreshToken: `apikey:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`,
      accessToken: key,
      expiresAt: 0,
      rateLimitResetTime: 0,
      isHealthy: true,
      failCount: 0,
      usedCount: usage.usedCount,
      limitCount: usage.limitCount
    }

    await this.repository.save(acc)
    await this.accountManager?.addAccount?.(acc)

    logger.log('API key sign-in: account saved', { email, region })
    return { type: 'success', key: MANAGED_KEY }
  }

  /**
   * The key's profile ARN. A key binds to one region's host, so sweep the known
   * regions — only `KIRO_API_KEY` need be set, never a region. Throws the
   * rejection (actionable) over a reach error when no host accepts the key.
   */
  private async resolveProfileArn(key: string, preferred: KiroRegion): Promise<string> {
    const regions = [preferred, ...KIRO_SERVICE_REGIONS.filter((r) => r !== preferred)]

    let lastRejection: Error | undefined
    let lastReachFailure: Error | undefined
    for (const region of regions) {
      const outcome = await this.getProfile(key, region)
      if (outcome.kind === 'arn') return outcome.arn
      if (outcome.kind === 'rejected') lastRejection = outcome.error
      else lastReachFailure = outcome.error
    }

    throw lastRejection ?? lastReachFailure ?? new Error('Could not validate the API key with Kiro')
  }

  /** One GetProfile call, classified so the sweep knows to continue or stop. */
  private async getProfile(
    key: string,
    region: KiroRegion
  ): Promise<
    | { kind: 'arn'; arn: string }
    | { kind: 'rejected'; error: Error }
    | { kind: 'other'; error: Error }
  > {
    let res: Response
    try {
      res = await fetch(
        `https://management.${region}.kiro.dev/?origin=${KIRO_CONSTANTS.ORIGIN_AI_EDITOR}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/x-amz-json-1.0',
            'X-Amz-Target': 'AmazonCodeWhispererService.GetProfile',
            ...kiroHeaders(undefined, 'apikey')
          },
          body: '{}'
        }
      )
    } catch (e) {
      return {
        kind: 'other',
        error: new Error(
          `Could not reach Kiro to validate the API key (${redactSecrets(describeError(e))})`
        )
      }
    }

    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return {
        kind: 'rejected',
        error: new Error(
          'Kiro rejected the API key. Check that it is active and that API keys are enabled for your account.'
        )
      }
    }
    if (!res.ok) {
      return {
        kind: 'other',
        error: new Error(`Could not validate the API key with Kiro (HTTP ${res.status})`)
      }
    }

    const data: any = await res.json().catch(() => undefined)
    const arn = data?.profile?.arn
    if (typeof arn !== 'string' || !arn) {
      return { kind: 'other', error: new Error('Kiro returned no profile for this API key') }
    }
    return { kind: 'arn', arn }
  }
}
