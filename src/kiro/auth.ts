import type { KiroAuthDetails, RefreshParts } from '../plugin/types'

export function decodeRefreshToken(refresh: string): RefreshParts {
  const parts = refresh.split('|')
  if (parts.length < 2) return { refreshToken: parts[0]!, authMethod: 'desktop' }
  const refreshToken = parts[0]!
  const authMethod = parts[parts.length - 1] as any
  if (authMethod === 'idc')
    return { refreshToken, clientId: parts[1], clientSecret: parts[2], authMethod: 'idc' }
  if (authMethod === 'desktop') return { refreshToken, authMethod: 'desktop' }
  if (authMethod === 'apikey') return { refreshToken, authMethod: 'apikey' }
  return { refreshToken, authMethod: 'desktop' }
}

export function accessTokenExpired(auth: KiroAuthDetails, bufferMs = 120000): boolean {
  // A key has no expiry; expires is stored as 0, which must not read as lapsed.
  if (auth.authMethod === 'apikey') return !auth.access
  if (!auth.access || !auth.expires) return true
  return Date.now() >= auth.expires - bufferMs
}

export function encodeRefreshToken(parts: RefreshParts): string {
  if (parts.authMethod === 'idc') {
    if (!parts.clientId || !parts.clientSecret) throw new Error('Missing credentials')
    return `${parts.refreshToken}|${parts.clientId}|${parts.clientSecret}|idc`
  }
  if (parts.authMethod === 'apikey') return `${parts.refreshToken}|apikey`
  return `${parts.refreshToken}|desktop`
}
