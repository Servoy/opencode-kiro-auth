import { describe, expect, mock, test } from 'bun:test'

mock.module('../plugin/logger.js', () => ({
  log: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  setDebugEnabled: () => {},
  getTimestamp: () => '2026-10-07T00:00:00.000Z',
  logApiError: () => {},
  logApiRequest: () => {},
  logApiResponse: () => {}
}))

const { selfHealHostCredential } = await import('../v2/connect-self-heal.js')
const { KIRO_MANAGED_CREDENTIAL_ACCESS } = await import('../v2/integration.js')

type ConnectCall = { integrationID: string; key: string }

function makeIntegration(opts: {
  active?: unknown
  activeThrows?: boolean
  connectThrows?: boolean
}) {
  const connectCalls: ConnectCall[] = []
  return {
    connectCalls,
    connect: {
      key: async (input: ConnectCall) => {
        if (opts.connectThrows) throw new Error('host rejected key')
        connectCalls.push(input)
      }
    },
    connection: {
      active: async () => {
        if (opts.activeThrows) throw new Error('store unavailable')
        return opts.active
      }
    }
  }
}

describe('selfHealHostCredential', () => {
  test('writes the managed placeholder when an account exists, no host connection, and no API key', async () => {
    const integration = makeIntegration({ active: undefined })
    const healed = await selfHealHostCredential(integration, 'kiro', true)
    expect(healed).toBe(true)
    expect(integration.connectCalls).toEqual([
      { integrationID: 'kiro', key: KIRO_MANAGED_CREDENTIAL_ACCESS }
    ])
  })

  test('hands the host the REAL API key when one is configured, not the sentinel', async () => {
    // A real ksk_ value is what lets the registered key method stand behind the
    // host credential; the sentinel was rejected and the provider never came up.
    const integration = makeIntegration({ active: undefined })
    const healed = await selfHealHostCredential(
      integration,
      'kiro',
      true,
      'ksk_real_key_000000000000'
    )
    expect(healed).toBe(true)
    expect(integration.connectCalls).toEqual([
      { integrationID: 'kiro', key: 'ksk_real_key_000000000000' }
    ])
  })

  test('a blank/whitespace API key falls back to the sentinel', async () => {
    const integration = makeIntegration({ active: undefined })
    await selfHealHostCredential(integration, 'kiro', true, '   ')
    expect(integration.connectCalls[0]!.key).toBe(KIRO_MANAGED_CREDENTIAL_ACCESS)
  })

  test('does nothing without a usable account', async () => {
    const integration = makeIntegration({ active: undefined })
    const healed = await selfHealHostCredential(integration, 'kiro', false)
    expect(healed).toBe(false)
    expect(integration.connectCalls).toHaveLength(0)
  })

  test('never overwrites an existing host connection', async () => {
    const integration = makeIntegration({ active: { connected: true } })
    const healed = await selfHealHostCredential(integration, 'kiro', true)
    expect(healed).toBe(false)
    expect(integration.connectCalls).toHaveLength(0)
  })

  test('a failed connect.key falls back to false so the caller keeps warning', async () => {
    const integration = makeIntegration({ active: undefined, connectThrows: true })
    const healed = await selfHealHostCredential(integration, 'kiro', true)
    expect(healed).toBe(false)
  })

  test('an unreadable connection store is treated as no connection, not a crash', async () => {
    const integration = makeIntegration({ activeThrows: true })
    const healed = await selfHealHostCredential(integration, 'kiro', true)
    expect(healed).toBe(true)
    expect(integration.connectCalls).toHaveLength(1)
  })
})
