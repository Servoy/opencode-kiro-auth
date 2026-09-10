import type { AuthOuathResult } from '@opencode-ai/plugin'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractRegionFromArn, normalizeRegion } from '../../constants.js'
import type { AccountRepository } from '../../infrastructure/database/account-repository.js'
import {
  authorizeKiroIDC,
  listAvailableProfileArnsAcrossRegions,
  pollKiroIDCToken
} from '../../kiro/oauth-idc.js'
import { createDeterministicAccountId } from '../../plugin/accounts.js'
import { getConfigDir } from '../../plugin/config/loader.js'
import * as logger from '../../plugin/logger.js'
import { makePlaceholderEmail } from '../../plugin/sync/kiro-cli-parser.js'
import { readActiveProfileArnFromKiroCli } from '../../plugin/sync/kiro-cli-profile.js'
import type { KiroRegion, ManagedAccount } from '../../plugin/types.js'
import { fetchUsageLimits } from '../../plugin/usage.js'

function persistIdcConfigDefaults(
  startUrl: string | undefined,
  idcRegion: KiroRegion | undefined,
  profileArn: string | undefined
): void {
  const configPath = join(getConfigDir(), 'kiro.json')

  let config: Record<string, unknown> = {}
  try {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>
      }
    }
  } catch {
    return
  }

  let changed = false
  if (startUrl && !config.idc_start_url) {
    config.idc_start_url = startUrl
    changed = true
  }
  if (idcRegion && !config.idc_region) {
    config.idc_region = idcRegion
    changed = true
  }
  if (profileArn && !config.idc_profile_arn) {
    config.idc_profile_arn = profileArn
    changed = true
  }

  if (!changed) return

  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2))
  } catch (e) {
    logger.warn('persistIdcConfigDefaults: write failed', {
      error: e instanceof Error ? e.message : String(e)
    })
  }
}

function resolveBrowserCommand(url: string): { bin: string; args: string[]; source: string } {
  // KIRO_BROWSER/BROWSER override for hosts needing a custom launcher (`%s` =
  // URL, else appended). Follows the freedesktop $BROWSER convention.
  const override = process.env.KIRO_BROWSER || process.env.BROWSER
  if (override && override.trim()) {
    const parts = override.trim().split(/\s+/)
    const bin = parts[0]!
    const rest = parts.slice(1)
    const hasPlaceholder = rest.some((p) => p.includes('%s'))
    const args = hasPlaceholder ? rest.map((p) => p.replace(/%s/g, url)) : [...rest, url]
    return { bin, args, source: process.env.KIRO_BROWSER ? 'KIRO_BROWSER' : 'BROWSER' }
  }

  // Absolute path so an IDE's PATH wrapper can't shadow the launcher and route
  // the URL into its embedded browser instead of the system default.
  const platform = process.platform
  if (platform === 'win32') return { bin: 'cmd', args: ['/c', 'start', '', url], source: 'default' }
  if (platform === 'darwin') return { bin: '/usr/bin/open', args: [url], source: 'default' }
  return { bin: '/usr/bin/xdg-open', args: [url], source: 'default' }
}

const openBrowser = (url: string) => {
  if (process.env.NODE_ENV === 'test' || process.env.KIRO_DISABLE_BROWSER) {
    logger.log('openBrowser: skipped (test/disabled)', { url })
    return
  }
  const { bin, args, source } = resolveBrowserCommand(url)
  logger.log('openBrowser: launching', { bin, source, url })
  try {
    // detached + unref so the launcher is decoupled from the IDE-spawned parent.
    const child = execFile(bin, args, { detached: true, stdio: 'ignore' } as any, (error) => {
      if (error) {
        logger.warn('openBrowser: launch failed', { bin, source, url, error: error.message })
      } else {
        logger.log('openBrowser: launched ok', { bin, source })
      }
    })
    child.on('error', (error) => {
      logger.warn('openBrowser: spawn error', {
        bin,
        source,
        url,
        error: error instanceof Error ? error.message : String(error)
      })
    })
    child.unref()
  } catch (e) {
    logger.warn('openBrowser: threw synchronously', {
      bin,
      source,
      url,
      error: e instanceof Error ? e.message : String(e)
    })
  }
}

function normalizeStartUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined

  const url = new URL(trimmed)
  url.hash = ''
  url.search = ''

  // Normalize common portal URL shapes to end in `/start` (AWS Builder ID and IAM Identity Center)
  if (url.pathname.endsWith('/start/')) url.pathname = url.pathname.replace(/\/start\/$/, '/start')
  if (!url.pathname.endsWith('/start')) url.pathname = url.pathname.replace(/\/+$/, '') + '/start'

  return url.toString()
}

function emailFromJwt(accessToken: string): string | undefined {
  try {
    const payload = accessToken.split('.')[1]
    if (!payload) return undefined
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString())
    return decoded.email || decoded.sub || undefined
  } catch {
    return undefined
  }
}

function buildDeviceUrl(startUrl: string, userCode: string): string {
  const url = new URL(startUrl)
  url.search = ''
  // Prefer `/start/` (with trailing slash) to match AWS portal URLs like `/start/#/device?...`.
  if (url.pathname.endsWith('/start')) url.pathname = `${url.pathname}/`
  url.pathname = url.pathname.replace(/\/start\/?$/, '/start/')
  url.hash = `#/device?user_code=${encodeURIComponent(userCode)}`
  return url.toString()
}

export class IdcAuthMethod {
  constructor(
    private config: any,
    private repository: AccountRepository,
    private accountManager: any
  ) {}

  async authorize(inputs?: Record<string, string>, signal?: AbortSignal): Promise<AuthOuathResult> {
    const configuredServiceRegion: KiroRegion = this.config.default_region
    const invokedWithoutPrompts = !inputs || Object.keys(inputs).length === 0

    const startUrl = normalizeStartUrl(inputs?.start_url || this.config.idc_start_url) || undefined
    // For the OIDC device-code flow, prefer explicit idc_region, then fall back to
    // the region from a pre-configured profileArn, then default_region. This ensures
    // accounts with a eu-central-1 profileArn don't hit oidc.us-east-1.amazonaws.com.
    const configuredProfileArn = this.config.idc_profile_arn
    const arnRegion = extractRegionFromArn(configuredProfileArn)
    const oidcRegion: KiroRegion = normalizeRegion(
      inputs?.idc_region || this.config.idc_region || arnRegion || configuredServiceRegion
    )
    logger.log('IDC authorize: resolved defaults', {
      hasInputs: !!inputs && Object.keys(inputs).length > 0,
      invokedWithoutPrompts,
      startUrlSource: inputs?.start_url ? 'inputs' : this.config.idc_start_url ? 'config' : 'none',
      oidcRegion,
      startUrl: startUrl ? new URL(startUrl).origin : undefined
    })

    // Step 1: get device code + verification URL (fast)
    logger.log('IDC authorize: requesting device code', { oidcRegion })
    const auth = await authorizeKiroIDC(oidcRegion, startUrl)
    logger.log('IDC authorize: device code received', {
      userCode: auth.userCode,
      interval: auth.interval,
      expiresIn: auth.expiresIn,
      hasVerificationUriComplete: !!auth.verificationUriComplete
    })

    // If a custom Identity Center start URL is provided, prefer the portal device page.
    // This avoids the AWS Builder ID device page (which often prompts for an email)
    // and routes the user into their org's IAM Identity Center sign-in.
    const verificationUrl = startUrl
      ? buildDeviceUrl(startUrl, auth.userCode)
      : auth.verificationUriComplete || auth.verificationUrl

    // Full verification URL logged so it can be opened manually if the browser
    // launch fails (temporary/debug — the URL is a one-time device-code page).
    logger.log('IDC authorize: verification URL ready', {
      verificationUrl,
      userCode: auth.userCode,
      usedStartUrlDevicePage: !!startUrl
    })

    // Open the *AWS* verification page directly (no local web server).
    openBrowser(verificationUrl)

    return {
      url: verificationUrl,
      instructions: `Open the verification URL and complete sign-in.\nCode: ${auth.userCode}`,
      method: 'auto',
      // Not part of AuthOuathResult, but the reauth flow needs it to size its
      // wait to the device code instead of guessing.
      expiresIn: auth.expiresIn,
      callback: async (): Promise<{ type: 'success'; key: string } | { type: 'failed' }> => {
        try {
          logger.log('IDC authorize: callback invoked, polling for token', {
            interval: auth.interval,
            expiresIn: auth.expiresIn,
            oidcRegion
          })
          // Step 2: poll until token is issued (standard device-code flow)
          const token = await pollKiroIDCToken(
            auth.clientId,
            auth.clientSecret,
            auth.deviceCode,
            auth.interval,
            auth.expiresIn,
            oidcRegion,
            signal
          )

          const requestedProfileArn =
            inputs?.profile_arn?.trim() || configuredProfileArn || readActiveProfileArnFromKiroCli()

          // Profiles are regional, so probe the requested ARN's region and the
          // other Kiro regions before drawing any conclusion.
          const { arns: availableArns, reachedAll } = await listAvailableProfileArnsAcrossRegions(
            token.accessToken,
            [oidcRegion, extractRegionFromArn(requestedProfileArn), configuredServiceRegion]
          )

          let profileArn: string | undefined
          if (availableArns.length > 0) {
            // A requested ARN the user isn't granted 403s on every request, so
            // trust the service's list over the requested/synced one.
            profileArn =
              requestedProfileArn && availableArns.includes(requestedProfileArn)
                ? requestedProfileArn
                : availableArns[0]
            if (profileArn !== requestedProfileArn) {
              logger.log('IDC authorize: using profileArn from ListAvailableProfiles', {
                profileArn,
                requestedProfileArn: requestedProfileArn || 'none'
              })
            }
          } else if (reachedAll) {
            // Every region answered and none granted a profile. That is the
            // service's verdict, and a locally configured ARN cannot override
            // it — signing in anyway just produces an account whose every
            // request 403s, which is the loop this message exists to prevent.
            throw new Error(
              'This account has no Amazon Q Developer / CodeWhisperer profile assigned, so it cannot use Kiro. Ask your AWS administrator to subscribe you to Amazon Q Developer (check for the QDefaultProfile tile in your AWS access portal), then sign in again.'
            )
          } else {
            // Some region could not be asked, so an empty list proves nothing.
            // Keep whatever the user configured rather than blocking sign-in.
            profileArn = requestedProfileArn
            if (profileArn) {
              logger.warn('IDC authorize: profile lookup incomplete, keeping the configured ARN', {
                profileArn
              })
            }
          }

          if (!profileArn) {
            throw new Error(
              'Could not reach CodeWhisperer to look up your profile, and no profile is configured. Set "idc_profile_arn" in kiro.json (or run "kiro-cli profile") and sign in again.'
            )
          }

          const serviceRegion =
            extractRegionFromArn(profileArn) || oidcRegion || configuredServiceRegion

          // Usage is metadata, not a login gate — a failed lookup must never
          // discard a valid sign-in.
          const usage = await fetchUsageLimits({
            refresh: '',
            access: token.accessToken,
            expires: token.expiresAt,
            authMethod: 'idc',
            region: serviceRegion,
            clientId: token.clientId,
            clientSecret: token.clientSecret,
            profileArn
          }).catch((e) => {
            logger.warn('fetchUsageLimits failed during auth; continuing with zeroed usage', {
              serviceRegion,
              error: e instanceof Error ? e.message : String(e)
            })
            return { usedCount: 0, limitCount: 0, email: undefined }
          })

          if (!usage.email) usage.email = emailFromJwt(token.accessToken)

          const email =
            usage.email || makePlaceholderEmail('idc', serviceRegion, token.clientId, profileArn)
          const id = createDeterministicAccountId(email, 'idc', token.clientId, profileArn)
          const acc: ManagedAccount = {
            id,
            email,
            authMethod: 'idc',
            region: serviceRegion,
            oidcRegion: oidcRegion,
            clientId: token.clientId,
            clientSecret: token.clientSecret,
            profileArn,
            startUrl: startUrl || undefined,
            refreshToken: token.refreshToken,
            accessToken: token.accessToken,
            expiresAt: token.expiresAt,
            rateLimitResetTime: 0,
            isHealthy: true,
            failCount: 0,
            usedCount: usage.usedCount,
            limitCount: usage.limitCount
          }

          try {
            await this.repository.save(acc)
            await this.accountManager?.addAccount?.(acc)
            persistIdcConfigDefaults(acc.startUrl, acc.oidcRegion, acc.profileArn)
          } catch (e) {
            // The token is valid; a persistence hiccup must not fail sign-in.
            // The account stays in memory and gets persisted on next save.
            logger.warn('IDC authorize: account persist failed, continuing', {
              email,
              error: e instanceof Error ? e.message : String(e)
            })
          }

          logger.log('IDC authorize: token issued', {
            email,
            serviceRegion,
            hasProfileArn: !!profileArn
          })
          return { type: 'success', key: token.accessToken }
        } catch (e: any) {
          // Only a failure to obtain the token itself is fatal. Everything
          // after a valid token (usage, save) is recovered above, so reaching
          // here means the device-code exchange genuinely failed.
          const err = e instanceof Error ? e : new Error(String(e))
          logger.error('IDC auth callback failed', err)
          throw new Error(
            `IDC authorization failed: ${err.message}. Check the plugin log (plugin.log next to your kiro.json). For Identity Center accounts, ensure a Q Developer/CodeWhisperer profile is selected (try: kiro-cli profile).`
          )
        }
      }
    } as AuthOuathResult
  }
}
