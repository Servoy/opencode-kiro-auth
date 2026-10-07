import * as logger from '../plugin/logger.js'
import { KIRO_MANAGED_CREDENTIAL_ACCESS } from './integration.js'

/** The slice of the v2 integration domain the self-heal needs. */
export interface SelfHealIntegration {
  connect: { key(input: { integrationID: string; key: string }): Promise<void> }
  connection: { active(integrationID: string): Promise<unknown | undefined> }
}

/**
 * Give the host a credential when a usable account exists but the host has none,
 * so the provider registers without a manual `opencode auth import`. Never
 * overwrites an existing connection or acts without a usable account.
 *
 * The real API key is handed over when configured (the host stores a valid
 * Credential.Key the key method stands behind); otherwise the managed sentinel,
 * which keeps the host store inert for CLI/IDC accounts. Trade-off: the real key
 * means a second plaintext copy in opencode.db, accepted because it is already
 * on this machine in the env/kiro.json it came from.
 */
export async function selfHealHostCredential(
  integration: SelfHealIntegration,
  integrationID: string,
  hasUsableAccount: boolean,
  apiKey?: string
): Promise<boolean> {
  if (!hasUsableAccount) return false

  const existing = await integration.connection.active(integrationID).catch(() => undefined)
  if (existing) return false

  const key = apiKey?.trim() || KIRO_MANAGED_CREDENTIAL_ACCESS
  try {
    await integration.connect.key({ integrationID, key })
    logger.log(
      `Registered a host credential for "${integrationID}" so the provider registers ` +
        `(${apiKey ? 'API key' : 'managed sentinel'}); real tokens stay in kiro.db.`
    )
    return true
  } catch (e) {
    // warn, not debug: this is exactly why the provider does not come up.
    logger.warn(
      `Self-heal: connect.key failed, provider will not register: ` +
        `${e instanceof Error ? e.message : String(e)}`
    )
    return false
  }
}
