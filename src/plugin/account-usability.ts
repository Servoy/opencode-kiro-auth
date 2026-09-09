import { isPermanentError } from './health'
import type { ManagedAccount } from './types'

export type AccountUsability =
  { usable: true } | { usable: false; reason: string; permanent: boolean }

// Single source of truth for whether an account can serve a request. All
// selection, health, and reauth decisions go through this so "usable" never
// diverges between code paths.
export function evaluateAccount(acc: ManagedAccount, now = Date.now()): AccountUsability {
  // An IDC account without a profileArn 403s on every request — never recoverable.
  if (acc.authMethod === 'idc' && !acc.profileArn) {
    return { usable: false, reason: 'missing profileArn', permanent: true }
  }

  if (!acc.accessToken || !acc.refreshToken) {
    return { usable: false, reason: 'missing credentials', permanent: true }
  }

  if (isPermanentError(acc.unhealthyReason)) {
    return { usable: false, reason: acc.unhealthyReason || 'permanent error', permanent: true }
  }

  if (!acc.isHealthy) {
    if (acc.failCount >= 10) {
      return { usable: false, reason: 'fail count exhausted', permanent: true }
    }
    if (acc.recoveryTime && now < acc.recoveryTime) {
      return { usable: false, reason: 'recovering', permanent: false }
    }
  }

  if (acc.rateLimitResetTime && now < acc.rateLimitResetTime) {
    return { usable: false, reason: 'rate-limited', permanent: false }
  }

  return { usable: true }
}

export function isUsableAccount(acc: ManagedAccount, now = Date.now()): boolean {
  return evaluateAccount(acc, now).usable
}

// Structurally broken: can never succeed as-is, regardless of retries.
export function isPermanentlyUnusable(acc: ManagedAccount, now = Date.now()): boolean {
  const e = evaluateAccount(acc, now)
  return !e.usable && e.permanent
}
