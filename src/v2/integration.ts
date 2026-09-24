import type {
  V2Credential,
  V2IntegrationOAuthAuthorization,
  V2IntegrationOAuthMethod
} from './types.js'

/**
 * The v1 `authorize` result shape (from `IdcAuthMethod.authorize`): a device
 * verification URL plus a `callback` that polls for the token and, as a side
 * effect, persists the account into kiro.db.
 */
export interface V1AuthorizeResult {
  url: string
  method?: string
  instructions?: string
  expiresIn?: number
  callback: () => Promise<{ type: 'success'; key?: string } | { type: 'failed' }>
}

/** A single entry from `AuthHandler.getMethods()`. */
export interface V1AuthMethod {
  label: string
  type: string
  prompts?: unknown[]
  authorize: (inputs?: Record<string, string>) => Promise<V1AuthorizeResult>
}

/**
 * A placeholder OAuth credential handed to the v2 host after a successful
 * sign-in. Kiro manages the real tokens itself in kiro.db (rotation, health,
 * per-account profileArn); the host only needs a truthy credential to mark the
 * integration connected. Empty `refresh`/`expires` signal there is nothing for
 * the host to refresh — that stays the plugin's job, exactly as on v1.
 */
export type V2PlaceholderCredential = V2Credential

export interface V2IntegrationMethodRegistration {
  integrationID: string
  method: V2IntegrationOAuthMethod
  authorize: (answer: unknown) => Promise<V2IntegrationOAuthAuthorization>
}

/** Sentinel access value so a placeholder credential is never mistaken for a token. */
export const KIRO_MANAGED_CREDENTIAL_ACCESS = 'kiro-managed'

/**
 * Build the placeholder credential the host stores after a self-managed
 * sign-in. Exported so a test can assert it decodes as a real
 * `Credential.OAuth` and carries no usable token.
 */
export function buildPlaceholderCredential(methodID: string): V2PlaceholderCredential {
  return {
    type: 'oauth',
    methodID,
    refresh: '',
    access: KIRO_MANAGED_CREDENTIAL_ACCESS,
    expires: 0
  }
}

/**
 * Adapt the v1 `AuthHandler` OAuth methods to v2 integration method
 * registrations. Pure: performs no host I/O, so it is unit-testable without a
 * live context.
 *
 * v2 integration expects the host to own the credential, but Kiro keeps its
 * accounts in kiro.db (multi-account rotation, health, profileArn). So the v2
 * `authorize` is used only as a trigger: it runs the v1 device-code flow
 * (which persists the account), then resolves a placeholder credential purely
 * so the host shows the integration as connected. The real auth never leaves
 * kiro.db.
 */
export function buildIntegrationMethods(
  integrationID: string,
  v1Methods: V1AuthMethod[]
): V2IntegrationMethodRegistration[] {
  return v1Methods.map((m, i) => {
    const methodID = `${integrationID}-oauth-${i}`
    return {
      integrationID,
      method: {
        id: methodID,
        type: 'oauth' as const,
        label: m.label
      },
      authorize: async (): Promise<V2IntegrationOAuthAuthorization> => {
        const started = await m.authorize({})
        return {
          url: started.url,
          instructions: started.instructions ?? 'Complete sign-in in your browser.',
          expiresAt: started.expiresIn ? Date.now() + started.expiresIn * 1000 : undefined,
          mode: 'auto',
          // Run the v1 device-code poll (persists the account to kiro.db), then
          // hand back a placeholder so the host marks the integration connected.
          callback: started.callback().then(() => buildPlaceholderCredential(methodID))
        }
      }
    }
  })
}
