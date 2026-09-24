import type { RequestHandler } from '../core/request/request-handler.js'
import type { ToastFn } from '../plugin/toast.js'

/**
 * Matches Kiro's inference endpoints: the Pro `runtime.<region>.kiro.dev` host
 * and the standard `q.<region>.amazonaws.com` host. Kept in sync with the
 * pattern in `request-handler.ts` so the v2 hook only intercepts Kiro traffic
 * and lets every other provider request pass through untouched.
 */
const KIRO_API_PATTERN =
  /^(https?:\/\/)?(q\.[a-z0-9-]+\.amazonaws\.com|runtime\.[a-z0-9-]+\.kiro\.dev)/

export interface RequestBridge {
  /** True when the URL is a Kiro endpoint this plugin should handle. */
  isKiroUrl(url: string): boolean
  /** Run the request through the shared RequestHandler and return its Response. */
  handleRequest(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

/**
 * Wraps the existing v1 `RequestHandler` so v2 session hooks can drive it.
 *
 * Route A (http.request/http.response hooks): the setup hook reads the
 * intercepted request, calls `handleRequest`, and assigns the returned Response
 * onto the `http.response` event. The RequestHandler already returns a real
 * streaming OpenAI-SSE `Response`, so no local proxy is needed.
 */
export function createRequestBridge(handler: RequestHandler, toast: ToastFn): RequestBridge {
  return {
    isKiroUrl(url: string): boolean {
      return KIRO_API_PATTERN.test(url)
    },
    handleRequest(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      return handler.handle(input, init, toast)
    }
  }
}
