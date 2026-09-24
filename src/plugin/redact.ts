const MASK = '[redacted]'

/**
 * Authorization header values in the two shapes they reach the log: a JSON
 * string (`"authorization":"Bearer ..."`) and a header line
 * (`authorization: Bearer ...`). Captures the scheme so it survives, masks the
 * credential. Case-insensitive key, since hosts vary the casing.
 */
const AUTH_JSON = /("[Aa]uthorization"\s*:\s*")(Bearer|Basic|token)\s+[^"]+(")/g
const AUTH_LINE = /\b([Aa]uthorization\s*[:=]\s*)(Bearer|Basic|token)\s+\S+/g

/**
 * A bearer credential anywhere else: the scheme keyword followed by a long
 * opaque run. Bounded to 20+ chars so ordinary prose after "Bearer" is left
 * alone. Runs last so the structured patterns above win where they apply.
 */
const BEARER_LOOSE = /\b(Bearer|Basic|token)\s+[A-Za-z0-9._\-+/:]{20,}=*/g

/**
 * Mask secrets in a log line before it is written.
 *
 * Best-effort barrier against accidental credential leaks in plugin.log — the
 * live provider request carries a Kiro bearer token in its `authorization`
 * header, and the incoming-request debug line logs headers verbatim. Applied
 * at the logger's single write point so every level and message is covered.
 * The scheme keyword is kept so a redacted line still reads as an auth header.
 */
export function redactSecrets(input: string): string {
  return input
    .replace(AUTH_JSON, `$1$2 ${MASK}$3`)
    .replace(AUTH_LINE, `$1$2 ${MASK}`)
    .replace(BEARER_LOOSE, `$1 ${MASK}`)
}
