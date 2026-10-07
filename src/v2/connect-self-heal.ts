import * as logger from '../plugin/logger.js'
import { KIRO_MANAGED_CREDENTIAL_ACCESS } from './integration.js'

/** The slice of the v2 integration domain the self-heal needs. */
export interface SelfHealIntegration {
  connect: { key(input: { integrationID: string; key: string }): Promise<void> }
  connection: { active(integrationID: string): Promise<unknown | undefined> }
}

/**
 * Register a host credential when a usable Kiro account exists but the host has
 * none, so the provider registers without a manual `opencode auth import`.
 *
 * On v2 (opencode 2.0.23+) the host registers the provider only when it holds a
 * credential for the integration in this XDG home's opencode.db. A host run
 * under its own home (Servoy's `~/.servoy`) starts without one even though the
 * real account lives in kiro.db, and the host then fails a turn with an
 * unrelated error. The real tokens stay in kiro.db; this writes only the same
 * managed-sentinel placeholder a sign-in would. Never overwrites an existing
 * connection, and never acts without a usable account. Returns whether a
 * credential was written; false means the caller should keep warning.
 */
export async function selfHealHostCredential(
  integration: SelfHealIntegration,
  integrationID: string,
  hasUsableAccount: boolean
): Promise<boolean> {
  if (!hasUsableAccount) return false

  const existing = await integration.connection.active(integrationID).catch(() => undefined)
  if (existing) return false

  try {
    await integration.connect.key({
      integrationID,
      key: KIRO_MANAGED_CREDENTIAL_ACCESS
    })
    logger.log(
      `Registered a managed host credential for "${integrationID}" so the provider registers; ` +
        `real tokens stay in kiro.db.`
    )
    return true
  } catch (e) {
    logger.debug(
      `Self-heal: connect.key failed, leaving the diagnostic warning in place: ` +
        `${e instanceof Error ? e.message : String(e)}`
    )
    return false
  }
}
