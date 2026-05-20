import { CodeWhispererStreamingClient } from '@aws/codewhisperer-streaming-client'
import { KIRO_CONSTANTS } from '../constants.js'
import type { KiroAuthDetails } from './types'

const clientCache = new Map<string, { client: CodeWhispererStreamingClient; token: string }>()

export function createSdkClient(
  auth: KiroAuthDetails,
  region: string
): CodeWhispererStreamingClient {
  const cacheKey = `${region}:${auth.email || 'default'}`
  const cached = clientCache.get(cacheKey)

  if (cached && cached.token === auth.access) {
    return cached.client
  }

  const token = auth.access
  const client = new CodeWhispererStreamingClient({
    region,
    endpoint: `https://q.${region}.amazonaws.com`,
    token: () => Promise.resolve({ token }),
    maxAttempts: 1,
    customUserAgent: [[KIRO_CONSTANTS.USER_AGENT]],
    requestHandler: {
      connectionTimeout: 10000,
      requestTimeout: 120000
    }
  })

  client.middlewareStack.add(
    (next: any) => async (args: any) => {
      args.request.headers['x-amzn-kiro-agent-mode'] = 'vibe'
      args.request.headers['Connection'] = 'close'
      return next(args)
    },
    { step: 'build', name: 'addKiroHeaders' }
  )

  clientCache.set(cacheKey, { client, token })
  return client
}

export function clearSdkClientCache(): void {
  for (const entry of clientCache.values()) {
    entry.client.destroy()
  }
  clientCache.clear()
}
