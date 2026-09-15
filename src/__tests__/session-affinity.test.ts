import { describe, expect, test } from 'bun:test'
import { AccountSelector } from '../core/account/account-selector.js'
import { AccountManager } from '../plugin/accounts.js'
import type { ManagedAccount } from '../plugin/types.js'

function account(id: string): ManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    authMethod: 'idc',
    region: 'eu-central-1',
    profileArn: 'arn:aws:codewhisperer:eu-central-1:1:profile/AAA',
    refreshToken: 'r',
    accessToken: 'a',
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 0,
    limitCount: 1000
  } as ManagedAccount
}

/**
 * The real AccountManager on round-robin, so the test measures the selector
 * against the rotation it actually has to overrule. Only the edges are stubbed
 * — a repository that stores nothing and a toast that goes nowhere.
 */
function selectorFor(accounts: ManagedAccount[]) {
  const manager = new AccountManager(accounts, 'round-robin')
  const selector = new AccountSelector(
    manager,
    { auto_sync_kiro_cli: false, account_selection_strategy: 'round-robin' },
    async () => {},
    { findAll: async () => [], invalidateCache: () => {} } as any
  )
  return { manager, selector }
}

const quiet = () => {}

describe('a session stays on the account that served it', () => {
  test('a rotating pool is overruled for a session it already served', async () => {
    // A conversationId is only valid on the account that created it, so
    // rotating mid-conversation made the service reject it and the thread
    // start over. Testing the store alone said nothing about the selector.
    const { selector } = selectorFor([account('acc-a'), account('acc-b'), account('acc-c')])
    const session = `ses_affinity_${Date.now()}`

    const first = await selector.selectHealthyAccount(quiet, session)
    const second = await selector.selectHealthyAccount(quiet, session)
    const third = await selector.selectHealthyAccount(quiet, session)

    // Round-robin would have handed out three different accounts.
    expect(second!.id).toBe(first!.id)
    expect(third!.id).toBe(first!.id)
  })

  test('two sessions are free to land on different accounts', async () => {
    const { selector } = selectorFor([account('acc-a'), account('acc-b')])
    const now = Date.now()

    const a = await selector.selectHealthyAccount(quiet, `ses_a_${now}`)
    const b = await selector.selectHealthyAccount(quiet, `ses_b_${now}`)

    expect(a!.id).not.toBe(b!.id)
  })

  test('a pinned account that is gone falls back instead of stalling', async () => {
    // The pin is advisory: an account that can no longer serve must not hold
    // the session hostage.
    const healthy = account('acc-a')
    const spare = account('acc-b')
    const { manager, selector } = selectorFor([healthy, spare])
    const session = `ses_gone_${Date.now()}`

    const pinned = await selector.selectHealthyAccount(quiet, session)
    // Rate-limit the pinned one: the real manager now refuses to hand it out.
    manager.getAccounts().find((a) => a.id === pinned!.id)!.rateLimitResetTime = Date.now() + 60_000

    const again = await selector.selectHealthyAccount(quiet, session)
    expect(again).not.toBeNull()
    expect(again!.id).not.toBe(pinned!.id)
  })

  test('a request without a session still gets an account', async () => {
    const { selector } = selectorFor([account('acc-a')])
    expect((await selector.selectHealthyAccount(quiet))!.id).toBe('acc-a')
  })
})
