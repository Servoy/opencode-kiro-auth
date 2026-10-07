import type {
  V2Credential,
  V2FormStringField,
  V2IntegrationKeyMethod,
  V2IntegrationOAuthAuthorization,
  V2IntegrationOAuthMethod
} from './types.js'

/** A v1 auth prompt (from `idcPrompts`): a text field with a key and message. */
interface V1Prompt {
  type: string
  key: string
  message?: string
  placeholder?: string
}

/**
 * Map the v1 auth prompts to v2 form fields so the host renders the sign-in
 * inputs (Start URL, Region, Profile ARN). Dropping these was the v2 sign-in
 * bug: with no form the host asked nothing, called authorize with no answer,
 * and the device page fell back to AWS Builder ID. Returns undefined when there
 * are no prompts — the host form must be non-empty when present.
 */
function toV2Form(prompts: unknown): V2FormStringField[] | undefined {
  if (!Array.isArray(prompts) || prompts.length === 0) return undefined
  const fields = (prompts as V1Prompt[])
    .filter((p) => typeof p?.key === 'string' && p.key.length > 0)
    .map((p) => ({
      type: 'string' as const,
      key: p.key,
      title: p.message,
      placeholder: p.placeholder
    }))
  return fields.length > 0 ? fields : undefined
}

/** Narrow the host's form answer to the string inputs the v1 flow consumes. */
function answerToInputs(answer: unknown): Record<string, string> {
  if (!answer || typeof answer !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(answer as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

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

/** A single OAuth entry from `AuthHandler.getMethods()`. */
export interface V1AuthMethod {
  label: string
  type: 'oauth'
  prompts?: unknown[]
  authorize: (inputs?: Record<string, string>) => Promise<V1AuthorizeResult>
}

/** The API key entry: `authorize` stores the key itself and answers with the placeholder. */
export interface V1ApiAuthMethod {
  label: string
  type: 'api'
  prompts?: unknown[]
  authorize: (
    inputs?: Record<string, string>
  ) => Promise<{ type: 'success'; key: string } | { type: 'failed' }>
}

/** The v2 oauth method needs a url and the host may open it, so it points at Kiro's web app. */
const KIRO_API_KEYS_URL = 'https://app.kiro.dev/'

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
 * The v2 key method, registered only so the host accepts `connect.key` for the
 * self-heal (it refuses with "Key method not found" otherwise).
 */
export function buildKeyMethodRegistration(integrationID: string): {
  integrationID: string
  method: V2IntegrationKeyMethod
} {
  // No label: the interactive sign-in is the oauth method; a label here would
  // show a duplicate "Kiro API key" row in the picker.
  return { integrationID, method: { type: 'key' } }
}

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
 * Adapt the v1 `AuthHandler` methods to v2 integration method registrations.
 * Pure: performs no host I/O, so it is unit-testable without a live context.
 *
 * v2 integration expects the host to own the credential, but Kiro keeps its
 * accounts in kiro.db (multi-account rotation, health, profileArn). So the v2
 * `authorize` is used only as a trigger: it runs the v1 flow (which persists
 * the account), then resolves a placeholder credential purely so the host
 * shows the integration as connected. The real auth never leaves kiro.db.
 *
 * The API key method is registered as an `oauth` method with a form rather
 * than a host `key` method: a host-owned key would put a second copy of the
 * secret in the host's store.
 */
export function buildIntegrationMethods(
  integrationID: string,
  v1Methods: Array<V1AuthMethod | V1ApiAuthMethod>
): V2IntegrationMethodRegistration[] {
  return v1Methods.map((m, i) => {
    const methodID = m.type === 'api' ? `${integrationID}-apikey` : `${integrationID}-oauth-${i}`
    const form = toV2Form(m.prompts)
    const method: V2IntegrationOAuthMethod = {
      id: methodID,
      type: 'oauth' as const,
      label: m.label,
      ...(form ? { form } : {})
    }

    if (m.type === 'api') {
      return {
        integrationID,
        method,
        authorize: async (answer?: unknown): Promise<V2IntegrationOAuthAuthorization> => {
          const result = await m.authorize(answerToInputs(answer))
          if (result.type !== 'success') throw new Error('Kiro API key sign-in failed.')
          return {
            url: KIRO_API_KEYS_URL,
            instructions: 'API key saved.',
            mode: 'auto',
            callback: Promise.resolve(buildPlaceholderCredential(methodID))
          }
        }
      }
    }

    return {
      integrationID,
      method,
      authorize: async (answer?: unknown): Promise<V2IntegrationOAuthAuthorization> => {
        const started = await m.authorize(answerToInputs(answer))
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
