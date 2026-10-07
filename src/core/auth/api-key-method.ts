import { createHash } from 'node:crypto'
import { extractRegionFromArn, KIRO_CONSTANTS } from '../../constants.js'
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

export class ApiKeyAuthMethod {
  constructor(
    private config: { default_region?: KiroRegion },
    private repository: AccountRepository,
    private accountManager?: any
  ) {}

  async authorize(inputs?: Record<string, string>): Promise<{ type: 'success'; key: string }> {
    const key = (inputs?.api_key ?? '').trim()
    if (!API_KEY_PATTERN.test(key)) {
      throw new Error('Enter a Kiro API key starting with ksk_')
    }

    const defaultRegion = this.config.default_region ?? KIRO_CONSTANTS.DEFAULT_REGION
    const profileArn = await this.fetchProfileArn(key, defaultRegion)
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
      // Not empty: migrateToUniqueRefreshToken merges rows that share a refresh token.
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

  private async fetchProfileArn(key: string, region: KiroRegion): Promise<string> {
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
      throw new Error(
        `Could not reach Kiro to validate the API key (${redactSecrets(describeError(e))})`
      )
    }

    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new Error(
        'Kiro rejected the API key. Check that it is active and that API keys are enabled for your account.'
      )
    }
    if (!res.ok) {
      throw new Error(`Could not validate the API key with Kiro (HTTP ${res.status})`)
    }

    const data: any = await res.json().catch(() => undefined)
    const arn = data?.profile?.arn
    if (typeof arn !== 'string' || !arn) {
      throw new Error('Kiro returned no profile for this API key')
    }
    return arn
  }
}
