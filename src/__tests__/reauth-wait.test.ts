import { describe, expect, mock, test } from 'bun:test'

mock.module('../plugin/logger.js', () => ({
  debug: () => {},
  error: () => {},
  log: () => {},
  warn: () => {},
  getTimestamp: () => '2026-07-22T00:00:00.000Z',
  logApiError: () => {},
  logApiRequest: () => {},
  logApiResponse: () => {}
}))

const { reauthWaitMs } = await import('../core/request/request-handler.js')
const { pollKiroIDCToken, DeviceFlowAbortedError } = await import('../kiro/oauth-idc.js')

describe('re-auth wait window', () => {
  test('waits as long as the device code is valid', () => {
    // The device code AWS hands out lives for 10 minutes. Waiting 90s meant
    // anyone typing a password plus an MFA code timed out, and every timeout
    // opened a new browser tab with a new code — the re-auth loop.
    expect(reauthWaitMs(600)).toBe(600_000)
  })

  test('never waits less than two minutes', () => {
    expect(reauthWaitMs(30)).toBe(120_000)
    expect(reauthWaitMs(0)).toBe(120_000)
    expect(reauthWaitMs(undefined)).toBe(120_000)
  })

  test('caps the wait so a stuck sign-in cannot hang forever', () => {
    expect(reauthWaitMs(86_400)).toBe(600_000)
  })
})

describe('device-code polling', () => {
  test('stops as soon as the caller gives up', async () => {
    // An abandoned poll used to keep hitting the token endpoint for the rest of
    // the code's lifetime, and could still complete behind the caller's back.
    let tokenCalls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      tokenCalls++
      return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 })
    }) as unknown as typeof fetch

    const controller = new AbortController()
    const started = Date.now()
    const poll = pollKiroIDCToken(
      'client-id',
      'client-secret',
      'device-code',
      0.05,
      5,
      'eu-central-1',
      controller.signal
    )

    setTimeout(() => controller.abort(), 20)

    try {
      await expect(poll).rejects.toBeInstanceOf(DeviceFlowAbortedError)
      expect(Date.now() - started).toBeLessThan(1000)
      const callsAtAbort = tokenCalls
      await new Promise((r) => setTimeout(r, 150))
      expect(tokenCalls).toBe(callsAtAbort)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
