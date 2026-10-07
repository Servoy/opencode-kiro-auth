import { isUsableAccount } from './account-usability.js'
import { getConfigDir } from './config/paths.js'
import * as logger from './logger.js'
import { getCliDbPath } from './sync/kiro-cli-parser.js'
import type { ManagedAccount } from './types'

/**
 * Log how many accounts loaded and from where, so a store in the wrong XDG home
 * is seen at a glance instead of surfacing later as the host's misleading
 * "not available in your country". On zero usable accounts, name the kiro.db
 * that was read and the fix, since the host error points nowhere near the cause.
 */
export function logAccountDiagnostics(
  accounts: readonly ManagedAccount[],
  autoSync: boolean
): void {
  const configDir = getConfigDir()
  const usable = accounts.filter((a) => isUsableAccount(a)).length

  if (accounts.length === 0) {
    logger.warn(
      `No Kiro accounts in ${configDir}/kiro.db. ` +
        (autoSync
          ? `auto_sync_kiro_cli is on; expecting a sync from ${getCliDbPath()}.`
          : `If this host runs under its own XDG home, set auto_sync_kiro_cli: true ` +
            `or sign in again so the account lands in this store.`)
    )
    return
  }

  logger.log(`Accounts: ${accounts.length} loaded (${usable} usable) from ${configDir}/kiro.db`)
  if (usable === 0) {
    logger.warn(
      `All ${accounts.length} Kiro account(s) are unusable (expired, rate-limited or signed out). ` +
        `Sign in again or wait for the limit to reset.`
    )
  }
}

/**
 * Warn about the specific v2 dead end: a usable account exists in kiro.db, but
 * the host has no credential for the integration in this XDG home's opencode.db,
 * so it never registers the provider. The host shows nothing and later fails a
 * turn with an unrelated geographic error. Naming it here is the one signal that
 * points at the real fix — sign in (or import the credential) in this home.
 */
export function warnIfProviderWillNotRegister(
  hasUsableAccount: boolean,
  hasHostConnection: boolean
): void {
  if (hasUsableAccount && !hasHostConnection) {
    logger.warn(
      `A usable Kiro account exists in ${getConfigDir()}/kiro.db, but this opencode store has ` +
        `no credential for the Kiro integration, so the provider will not register. ` +
        `Sign in to Kiro in this environment (or import the credential into its opencode store) — ` +
        `the host otherwise reports an unrelated error such as "not available in your country".`
    )
  }
}
