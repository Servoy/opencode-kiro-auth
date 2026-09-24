import { describe, expect, mock, test } from 'bun:test'

// Spread the real module so silenced logging keeps every other export
// (getLogDir, etc.) — mock.module is process-global and a partial stub leaks
// into sibling test files that import those. See AGENTS.md testing standard.
const realLogger = await import('../plugin/logger.js')
mock.module('../plugin/logger.js', () => ({
  ...realLogger,
  debug: () => {},
  error: () => {},
  log: () => {},
  warn: () => {}
}))

// One access token, one expiry. On a single shared account every session sees
// it lapse at the same instant and — before coalescing — each fired its own
// network refresh. This counts the real network calls behind refreshIfNeeded
// so a stampede shows up as a number greater than one.
let refreshCalls = 0
mock.module('../plugin/token.js', () => ({
  refreshAccessToken: async (auth: any) => {
    refreshCalls++
    await new Promise((r) => setTimeout(r, 20))
    return { ...auth, access: 'fresh-token', expires: Date.now() + 3_600_000 }
  }
}))

const { TokenRefresher } = await import('../core/auth/token-refresher.js')

function createRefresher() {
  const account: any = {
    id: 'acc-1',
    email: 'user@servoy.com',
    authMethod: 'idc',
    region: 'eu-central-1',
    refreshToken: 'r',
    accessToken: 'stale',
    expiresAt: Date.now() - 1_000,
    isHealthy: true,
    failCount: 0
  }
  const accountManager: any = {
    updateFromAuth: async (acc: any, newAuth: any) => {
      acc.accessToken = newAuth.access
      acc.expiresAt = newAuth.expires
    },
    markUnhealthy: async () => {},
    toAuthDetails: (a: any) => ({
      access: a.accessToken,
      refresh: a.refreshToken,
      expires: a.expiresAt,
      authMethod: a.authMethod,
      region: a.region,
      email: a.email
    })
  }
  const repository: any = {
    save: async () => {},
    invalidateCache: () => {},
    findAll: async () => []
  }
  const config: any = {
    token_expiry_buffer_ms: 0,
    auto_sync_kiro_cli: false,
    account_selection_strategy: 'sticky'
  }
  const refresher = new TokenRefresher(config, accountManager, async () => {}, repository)
  return { refresher, account, auth: accountManager.toAuthDetails(account) }
}

describe('token refresh coalescing', () => {
  test('ten concurrent sessions on one expired token fire ONE network refresh', async () => {
    refreshCalls = 0
    const { refresher, account, auth } = createRefresher()

    // Ten sessions all hit refreshIfNeeded for the same account at once.
    await Promise.all(
      Array.from({ length: 10 }, () => refresher.refreshIfNeeded(account, auth, () => {}))
    )

    expect(refreshCalls).toBe(1)
  })

  test('a refresh persists the account exactly once, not twice', async () => {
    // updateFromAuth already writes the account (upsertAccount). A second
    // repository.save() right after was an identical full-table merge under the
    // OS file lock for the same token update — pure redundant lock pressure at
    // scale. Count persists: one refresh must persist once.
    refreshCalls = 0
    let persists = 0
    const account: any = {
      id: 'acc-1',
      email: 'user@servoy.com',
      authMethod: 'idc',
      region: 'eu-central-1',
      refreshToken: 'r',
      accessToken: 'stale',
      expiresAt: Date.now() - 1_000,
      isHealthy: true,
      failCount: 0
    }
    const accountManager: any = {
      updateFromAuth: async (acc: any, newAuth: any) => {
        acc.accessToken = newAuth.access
        acc.expiresAt = newAuth.expires
        persists++ // updateFromAuth's own upsertAccount
      },
      markUnhealthy: async () => {},
      toAuthDetails: (a: any) => ({
        access: a.accessToken,
        refresh: a.refreshToken,
        expires: a.expiresAt,
        authMethod: a.authMethod,
        region: a.region,
        email: a.email
      })
    }
    const repository: any = {
      save: async () => {
        persists++
      },
      invalidateCache: () => {},
      findAll: async () => []
    }
    const config: any = {
      token_expiry_buffer_ms: 0,
      auto_sync_kiro_cli: false,
      account_selection_strategy: 'sticky'
    }
    const refresher = new TokenRefresher(config, accountManager, async () => {}, repository)

    await refresher.refreshIfNeeded(account, accountManager.toAuthDetails(account), () => {})

    expect(persists).toBe(1)
  })

  test('a later refresh after the first settles is a fresh network call, not a stale share', async () => {
    refreshCalls = 0
    const { refresher, account, auth } = createRefresher()

    await refresher.refreshIfNeeded(account, auth, () => {})
    expect(refreshCalls).toBe(1)

    // Force it stale again: the in-flight promise from the first call must have
    // been cleared once it settled, so a genuinely new expiry triggers a new
    // network call rather than resolving instantly from a leftover promise.
    account.expiresAt = Date.now() - 1_000
    const staleAuth = { ...auth, access: 'stale', expires: Date.now() - 1_000 }
    await refresher.refreshIfNeeded(account, staleAuth, () => {})
    expect(refreshCalls).toBe(2)
  })
})
