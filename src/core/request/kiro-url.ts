/**
 * Which requests belong to Kiro, and how to tell when something else has
 * rewritten the URL out from under us.
 *
 * OpenCode addresses the Kiro provider by base URL, and this plugin claims a
 * request by looking at that URL. Another plugin can rewrite the URL before
 * the request leaves the process — a local proxy that keeps the original
 * upstream in its path is the common shape:
 *
 *   http://127.0.0.1:18789/bili/https://q.us-east-1.amazonaws.com/chat/completions
 *
 * An anchored pattern reads that as "not a Kiro request", so the plugin steps
 * aside and the host sends an OpenAI-shaped request straight to a Kiro
 * endpoint, which answers with a Coral UnknownOperationException. The user
 * sees an empty reply and nothing in this plugin's log says why.
 *
 * So the Kiro host is looked for inside the URL as well, and the request is
 * unwrapped to the original upstream, so the rest of the pipeline keeps
 * working with the URL the provider was configured with.
 */

/** The inference hosts Kiro serves from: CodeWhisperer and the Pro host. */
const KIRO_HOST_PATTERN = /^(?:q\.[a-z0-9-]+\.amazonaws\.com|runtime\.[a-z0-9-]+\.kiro\.dev)$/i

/**
 * The host of any absolute URL inside a string. Used to find the upstream a
 * proxy kept in the path of the URL it was rewritten to.
 */
const EMBEDDED_HOST_PATTERN = /https?:\/\/([a-z0-9.-]+(?::\d+)?)/gi

/** True when the host is one of Kiro's inference hosts. */
export function isKiroHost(host: string): boolean {
  if (typeof host !== 'string' || host.length === 0) return false
  // A URL's host carries the port when it is not the default one; the port
  // says nothing about which service answered.
  const name = host.toLowerCase().replace(/:\d+$/, '')
  return KIRO_HOST_PATTERN.test(name)
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

/**
 * The Kiro URL a request is aimed at, or null when it is not aimed at Kiro.
 *
 * A rewritten URL yields the original upstream it carries, so the caller
 * works with the URL the provider was configured with.
 */
export function resolveKiroUrl(url: string): string | null {
  if (typeof url !== 'string' || url.length === 0) return null

  const direct = hostOf(url)
  if (direct !== null && isKiroHost(direct)) return url

  // A rewritten URL keeps the original upstream in its path. Only the part
  // before the query is searched: a URL that mentions another URL in a query
  // parameter is not a request to that other URL.
  const path = url.split(/[?#]/)[0] ?? url
  for (const match of path.matchAll(EMBEDDED_HOST_PATTERN)) {
    const host = match[1]
    if (host === undefined || !isKiroHost(host)) continue
    const start = match.index ?? 0
    return url.slice(start)
  }

  return null
}
