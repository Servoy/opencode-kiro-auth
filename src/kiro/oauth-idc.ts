import {
  KIRO_AUTH_SERVICE,
  KIRO_CONSTANTS,
  KIRO_SERVICE_REGIONS,
  buildUrl,
  normalizeRegion
} from '../constants'
import * as logger from '../plugin/logger'
import type { KiroRegion } from '../plugin/types'

export interface KiroIDCAuthorization {
  verificationUrl: string
  verificationUriComplete: string
  userCode: string
  deviceCode: string
  clientId: string
  clientSecret: string
  interval: number
  expiresIn: number
  region: KiroRegion
  startUrl: string
}

export interface KiroIDCTokenResult {
  refreshToken: string
  accessToken: string
  expiresAt: number
  email: string
  clientId: string
  clientSecret: string
  region: KiroRegion
  authMethod: 'idc'
}

export async function authorizeKiroIDC(
  region?: KiroRegion,
  startUrl?: string
): Promise<KiroIDCAuthorization> {
  const effectiveRegion = normalizeRegion(region)
  const ssoOIDCEndpoint = buildUrl(KIRO_AUTH_SERVICE.SSO_OIDC_ENDPOINT, effectiveRegion)
  const effectiveStartUrl = startUrl || KIRO_AUTH_SERVICE.BUILDER_ID_START_URL

  try {
    const registerResponse = await fetch(`${ssoOIDCEndpoint}/client/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': KIRO_CONSTANTS.USER_AGENT
      },
      body: JSON.stringify({
        clientName: 'Kiro IDE',
        clientType: 'public',
        scopes: KIRO_AUTH_SERVICE.SCOPES,
        grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token']
      })
    })

    if (!registerResponse.ok) {
      const errorText = await registerResponse.text().catch(() => '')
      const error = new Error(`Client registration failed: ${registerResponse.status} ${errorText}`)
      throw error
    }

    const registerData = await registerResponse.json()
    const { clientId, clientSecret } = registerData

    if (!clientId || !clientSecret) {
      const error = new Error('Client registration response missing clientId or clientSecret')
      throw error
    }

    const deviceAuthResponse = await fetch(`${ssoOIDCEndpoint}/device_authorization`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': KIRO_CONSTANTS.USER_AGENT
      },
      body: JSON.stringify({
        clientId,
        clientSecret,
        startUrl: effectiveStartUrl
      })
    })

    if (!deviceAuthResponse.ok) {
      const errorText = await deviceAuthResponse.text().catch(() => '')
      const error = new Error(
        `Device authorization failed: ${deviceAuthResponse.status} ${errorText}`
      )
      throw error
    }

    const deviceAuthData = await deviceAuthResponse.json()

    const {
      verificationUri,
      verificationUriComplete,
      userCode,
      deviceCode,
      interval = 5,
      expiresIn = 600
    } = deviceAuthData

    if (!deviceCode || !userCode || !verificationUri || !verificationUriComplete) {
      const error = new Error('Device authorization response missing required fields')
      throw error
    }

    return {
      verificationUrl: verificationUri,
      verificationUriComplete,
      userCode,
      deviceCode,
      clientId,
      clientSecret,
      interval,
      expiresIn,
      region: effectiveRegion,
      startUrl: effectiveStartUrl
    }
  } catch (error) {
    throw error
  }
}

/** Sleep that resolves early when `signal` aborts. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Thrown by {@link pollKiroIDCToken} when its caller aborts the flow. */
export class DeviceFlowAbortedError extends Error {
  constructor() {
    super('Device authorization was cancelled')
    this.name = 'DeviceFlowAbortedError'
  }
}

/**
 * Poll the token endpoint until the user completes the device-code sign-in.
 *
 * Pass a `signal` to stop an abandoned flow; without one it keeps polling for
 * the full lifetime of the device code even after the caller has given up.
 *
 * @throws {DeviceFlowAbortedError} when `signal` aborts.
 */
export async function pollKiroIDCToken(
  clientId: string,
  clientSecret: string,
  deviceCode: string,
  interval: number,
  expiresIn: number,
  region: KiroRegion,
  signal?: AbortSignal
): Promise<KiroIDCTokenResult> {
  if (!clientId || !clientSecret || !deviceCode) {
    const error = new Error('Missing required parameters for token polling')
    throw error
  }

  const effectiveRegion = normalizeRegion(region)
  const ssoOIDCEndpoint = buildUrl(KIRO_AUTH_SERVICE.SSO_OIDC_ENDPOINT, effectiveRegion)

  const maxAttempts = Math.floor(expiresIn / interval)
  let currentInterval = interval * 1000
  let attempts = 0

  while (attempts < maxAttempts) {
    attempts++

    await abortableSleep(currentInterval, signal)
    if (signal?.aborted) throw new DeviceFlowAbortedError()

    try {
      const tokenResponse = await fetch(`${ssoOIDCEndpoint}/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': KIRO_CONSTANTS.USER_AGENT
        },
        body: JSON.stringify({
          clientId,
          clientSecret,
          deviceCode,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code'
        })
      })

      const responseText = await tokenResponse.text().catch(() => '')
      let tokenData: any = {}
      if (responseText) {
        try {
          tokenData = JSON.parse(responseText)
        } catch (parseError: any) {
          throw new Error(
            `Token polling failed: invalid JSON response (HTTP ${tokenResponse.status}): ${responseText.slice(0, 300)}`
          )
        }
      }

      if (tokenData.error) {
        const errorType = tokenData.error

        if (errorType === 'authorization_pending') {
          continue
        }

        if (errorType === 'slow_down') {
          currentInterval += 5000
          continue
        }

        if (errorType === 'expired_token') {
          const error = new Error(
            'Device code has expired. Please restart the authorization process.'
          )
          throw error
        }

        if (errorType === 'access_denied') {
          const error = new Error('Authorization was denied by the user.')
          throw error
        }

        const error = new Error(
          `Token polling failed: ${errorType} - ${tokenData.error_description || ''}`
        )
        throw error
      }

      const accessToken = tokenData.access_token || tokenData.accessToken
      const refreshToken = tokenData.refresh_token || tokenData.refreshToken
      const tokenExpiresIn = tokenData.expires_in || tokenData.expiresIn

      if (accessToken && refreshToken) {
        const expiresInSeconds = tokenExpiresIn || 3600
        const expiresAt = Date.now() + expiresInSeconds * 1000

        return {
          refreshToken,
          accessToken,
          expiresAt,
          email: 'builder-id@aws.amazon.com',
          clientId,
          clientSecret,
          region: effectiveRegion,
          authMethod: 'idc'
        }
      }

      if (!tokenResponse.ok) {
        const error = new Error(
          `Token request failed with status: ${tokenResponse.status} ${
            responseText ? `(${responseText.slice(0, 200)})` : ''
          }`
        )
        throw error
      }

      // If the service returned HTTP 200 but no tokens and no error, treat as invalid response.
      throw new Error(
        `Token polling failed: missing tokens in response: ${responseText ? responseText.slice(0, 300) : '[empty]'}`
      )
    } catch (error) {
      if (error instanceof DeviceFlowAbortedError) throw error
      if (
        error instanceof Error &&
        (error.message.includes('expired') ||
          error.message.includes('denied') ||
          error.message.includes('failed'))
      ) {
        throw error
      }

      if (attempts >= maxAttempts) {
        const finalError = new Error(
          `Token polling failed after ${attempts} attempts: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
        throw finalError
      }
    }
  }

  const timeoutError = new Error('Token polling timed out. Authorization may have expired.')
  throw timeoutError
}

/**
 * List the CodeWhisperer profiles a token can use, across regions.
 *
 * Profiles are regional, so `preferredRegions` is probed first and the
 * remaining Kiro service regions after. `reachedAll` is false when any region
 * failed to answer, which makes an empty `arns` inconclusive rather than proof
 * that nothing is granted.
 */
export async function listAvailableProfileArnsAcrossRegions(
  accessToken: string,
  preferredRegions: (KiroRegion | undefined)[]
): Promise<{ arns: string[]; reachedAll: boolean; reachedAny: boolean }> {
  const seen = new Set<KiroRegion>()
  const regions: KiroRegion[] = []
  for (const r of [...preferredRegions, ...KIRO_SERVICE_REGIONS]) {
    if (!r || seen.has(r)) continue
    seen.add(r)
    regions.push(r)
  }

  const results = await Promise.all(
    regions.map(async (region) => {
      try {
        return { region, arns: await listAvailableProfileArns(accessToken, region) }
      } catch (e) {
        logger.warn('ListAvailableProfiles failed', {
          region,
          error: e instanceof Error ? e.message : String(e)
        })
        return { region, arns: null as string[] | null }
      }
    })
  )

  const arns: string[] = []
  let reachedAny = false
  let reachedAll = true
  for (const r of results) {
    if (r.arns === null) {
      reachedAll = false
      continue
    }
    reachedAny = true
    for (const arn of r.arns) if (!arns.includes(arn)) arns.push(arn)
  }

  return { arns, reachedAll, reachedAny }
}

export async function listAvailableProfileArns(
  accessToken: string,
  region: KiroRegion
): Promise<string[]> {
  const host = buildUrl(KIRO_CONSTANTS.BASE_URL, region).replace(
    /\/generateAssistantResponse$/,
    '/'
  )
  const res = await fetch(host, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/x-amz-json-1.0',
      'X-Amz-Target': 'AmazonCodeWhispererService.ListAvailableProfiles',
      'x-amzn-kiro-agent-mode': 'vibe'
    },
    body: '{}'
  })
  if (!res.ok) throw new Error(`ListAvailableProfiles failed: ${res.status}`)
  const data: any = await res.json()
  const list = Array.isArray(data.profiles) ? data.profiles : []
  return list.map((p: any) => p.arn || p.profileArn).filter((a: unknown): a is string => !!a)
}
