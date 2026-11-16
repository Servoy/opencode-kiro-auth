import { resolveKiroUrl } from '../core/request/kiro-url.js'
import type { RequestHandler } from '../core/request/request-handler.js'
import type { ToastFn } from '../plugin/toast.js'

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
      // A URL another plugin rewrote still names its Kiro upstream, so the
      // request is recognised either way; see core/request/kiro-url.ts.
      return resolveKiroUrl(url) !== null
    },
    handleRequest(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      return handler.handle(input, init, toast)
    }
  }
}
