export function isPermanentError(reason?: string): boolean {
  if (!reason) return false
  const r = reason.toLowerCase()
  return (
    r.includes('invalid refresh token') ||
    r.includes('invalid grant provided') ||
    r.includes('invalid_grant') ||
    r.includes('invalid_client') ||
    r.includes('invalid_token') ||
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
