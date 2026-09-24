import { describe, expect, test } from 'bun:test'
import { noopToast } from '../plugin/toast.js'
import { createRequestBridge } from '../v2/request-bridge.js'

describe('createRequestBridge', () => {
  test('forwards the intercepted request to RequestHandler and returns its Response', async () => {
    const calls: Array<{ url: string }> = []
    const fakeHandler = {
      handle: async (input: unknown) => {
        const url = typeof input === 'string' ? input : (input as { url: string }).url
        calls.push({ url })
        return new Response('ok', { status: 200 })
      }
    }
    const bridge = createRequestBridge(fakeHandler as never, noopToast)
    const res = await bridge.handleRequest(
      'https://runtime.us-east-1.kiro.dev/v1/chat/completions',
      { body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }) }
    )
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('kiro.dev')
  })

  test('isKiroUrl matches Kiro runtime and CodeWhisperer hosts, rejects others', () => {
    const bridge = createRequestBridge({ handle: async () => new Response() } as never, noopToast)
    expect(bridge.isKiroUrl('https://runtime.us-east-1.kiro.dev/v1/chat/completions')).toBe(true)
    expect(bridge.isKiroUrl('https://q.us-east-1.amazonaws.com/x')).toBe(true)
    expect(bridge.isKiroUrl('https://api.openai.com/v1/chat/completions')).toBe(false)
  })
})
