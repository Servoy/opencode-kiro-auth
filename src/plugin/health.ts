/**
 * A failure that is about the network, not the credentials.
 *
 * These arrive as raw transport text ("Unable to connect. Is the computer able
 * to access the url?") from a sleeping laptop or a dropped link, and must stay
 * retryable — treating them as unrecoverable kills the request and leaves the
 * session needing a manual restart once connectivity returns.
 */
export function isTransientNetworkError(reason?: string): boolean {
  if (!reason) return false
  const r = reason.toLowerCase()
  return (
    r.includes('unable to connect') ||
    r.includes('typo in the url') ||
    r.includes('fetch failed') ||
    r.includes('network') ||
    r.includes('socket') ||
    r.includes('econnrefused') ||
    r.includes('econnreset') ||
    r.includes('enotfound') ||
    r.includes('etimedout') ||
    r.includes('eai_again') ||
    r.includes('epipe')
  )
}

export function isPermanentError(reason?: string): boolean {
  if (!reason) return false
  const r = reason.toLowerCase()
  return (
    r.includes('invalid refresh token') ||
    r.includes('invalid grant provided') ||
    r.includes('invalid_grant') ||
    r.includes('invalid_client') ||
    r.includes('invalid_token') ||
    r.includes('invalid_request') ||
    r.includes('invalid request') ||
    r.includes('invalidtoken') ||
    r.includes('expired_token') ||
    r.includes('expiredtoken') ||
    r.includes('expiredclient') ||
    r.includes('expired_client') ||
    r.includes('client is expired') ||
    r.includes('http_401') ||
    r.includes('account suspended') ||
    r.includes('unauthorized')
  )
}

/**
 * A server-side "try again" Kiro delivers inside an already-open event stream
 * rather than as an HTTP status, so the SDK's own retry never sees it. Safe to
 * replay only before anything is emitted; the caller enforces that window.
 */
export function isTransientStreamError(reason?: string): boolean {
  if (!reason) return false
  const r = reason.toLowerCase()
  return (
    r.includes('model_temporarily_unavailable') ||
    r.includes('temporarily unavailable') ||
    r.includes('service is unavailable') ||
    r.includes('serviceunavailable') ||
    r.includes('service_unavailable') ||
    r.includes('throttl') ||
    r.includes('too many requests') ||
    r.includes('slow down') ||
    r.includes('try again later')
  )
}
