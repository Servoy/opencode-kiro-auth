/**
 * A readable line for anything that was thrown.
 *
 * `String(e)` on a non-Error object yields "[object Object]", which is what an
 * AWS SDK error and an abort both reduced to — a logged failure that says
 * nothing is worse than no line at all, because it looks like it was handled.
 */
export function describeError(e: unknown): string {
  if (e instanceof Error) {
    const cause = e.cause instanceof Error ? ` (caused by ${e.cause.name}: ${e.cause.message})` : ''
    return `${e.name}: ${e.message}${cause}`
  }

  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>
    // AWS SDK errors are plain objects carrying these, not Error instances.
    const parts = ['name', 'code', '$fault', 'message']
      .filter((k) => typeof o[k] === 'string' || typeof o[k] === 'number')
      .map((k) => `${k}=${String(o[k])}`)
    const status = (o.$metadata as { httpStatusCode?: number } | undefined)?.httpStatusCode
    if (status) parts.push(`status=${status}`)
    if (parts.length > 0) return parts.join(' ')

    try {
      return JSON.stringify(e).slice(0, 300)
    } catch {
      return Object.prototype.toString.call(e)
    }
  }

  return String(e)
}
