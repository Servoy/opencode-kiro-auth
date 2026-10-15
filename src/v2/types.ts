/**
 * The subset of the OpenCode v2 plugin context this plugin actually consumes.
 *
 * Hand-mirrored (not re-exported) so drift in the official surface is caught by
 * `mirror-conformance.ts` rather than silently absorbed. The v1 main build uses
 * only these shapes; type-only, so no `@opencode/plugin` code loads at runtime.
 */

export interface V2Registration {
  dispose(): Promise<void>
}

export interface V2ProviderInfo {
  id: string
  name: string
  activation: 'auto' | 'enabled' | 'disabled'
  package: string
  /** Links this provider to the Kiro integration that supplies its credential. */
  integrationID?: string
  settings?: Record<string, unknown>
  headers?: Record<string, string>
}

/** The three fields `Model.Capabilities` has; reasoning rides `compatibility`. */
export interface V2ModelCapabilities {
  tools: boolean
  input: Array<'text' | 'image' | 'pdf'>
  output: ['text']
}

/**
 * How a model has to be talked to for reasoning and token ceilings: naming the
 * wire field is what makes a model render thinking.
 */
export interface V2ModelCompatibility {
  /** Wire field Kiro streams thinking under; see openai-converter.ts. */
  reasoningField?: string
  /** Every assistant message must carry the reasoning field, even when empty. */
  requireReasoning?: boolean
  /** Which key carries the output-token ceiling. */
  maxTokensField?: 'max_completion_tokens' | 'max_tokens'
  supportsEffortUpdates?: boolean
}

export interface V2ModelVariant {
  id: string
  settings?: Record<string, unknown>
}

/**
 * One priced tier. Kiro bills credits rather than dollars, so the plugin emits
 * an empty list; the shape is still declared so a future entry cannot drift.
 */
export interface V2ModelCost {
  input: number
  output: number
  cache: { read: number; write: number }
}

export interface V2ModelInfo {
  id: string
  modelID: string
  providerID: string
  name: string
  capabilities: V2ModelCapabilities
  compatibility?: V2ModelCompatibility
  variants: V2ModelVariant[]
  time: { released: number }
  cost: V2ModelCost[]
  status: 'active' | 'alpha' | 'beta' | 'deprecated'
  enabled: boolean
  limit: { context: number; output: number; input?: number }
}

export interface V2ProviderEditor {
  add(input: {
    info: V2ProviderInfo
    models: readonly V2ModelInfo[]
    sourceConnection?: unknown
  }): void
  update(providerID: string, update: (provider: V2ProviderInfo) => void): void
}

export interface V2ProviderDomain {
  transform(callback: (editor: V2ProviderEditor) => void): Promise<V2Registration>
  reload(): Promise<void>
}

export interface V2ModelEditor {
  list(providerID?: string): readonly V2ModelInfo[]
  update(providerID: string, modelID: string, update: (model: V2ModelInfo) => void): void
}

export interface V2ModelDomain {
  transform(callback: (editor: V2ModelEditor) => void): Promise<V2Registration>
  reload(): Promise<void>
}

export interface V2WebSearchResult {
  url: string
  title?: string
  content?: string
  time: { published?: number }
}

export interface V2WebSearchDefinition {
  readonly id: string
  readonly name: string
  execute(
    input: { query: string },
    context: { signal: AbortSignal }
  ): Promise<readonly V2WebSearchResult[]>
}

export interface V2WebSearchEditor {
  add(definition: V2WebSearchDefinition): void
  readonly default: {
    get(): string | false | undefined
    set(selection: string | false): void
  }
}

export interface V2WebSearchDomain {
  transform(callback: (editor: V2WebSearchEditor) => void): Promise<V2Registration>
  reload(): Promise<void>
}

// A single v2 form field. Mirrors the subset of @opencode/schema Form.StringField
// the integration sign-in needs: a text input with a key, a title and an
// optional placeholder. The host renders these before calling authorize.
export interface V2FormStringField {
  type: 'string'
  key: string
  title?: string
  placeholder?: string
  required?: boolean
}

export interface V2IntegrationOAuthMethod {
  id: string
  type: 'oauth'
  label: string
  // The sign-in form the host shows before authorize. Omitted when the method
  // asks for nothing. Non-empty when present (the host schema requires it).
  form?: V2FormStringField[]
}

// A host-side env method: the host forms a connection from the named environment
// variable on its own and keeps it out of the sign-in picker. This is how a
// configured KIRO_API_KEY brings the provider up headlessly (CI, an IDE launched
// from a desktop icon) with no sign-in step.
export interface V2IntegrationEnvMethod {
  type: 'env'
  names: string[]
}

export interface V2Credential {
  type: 'oauth'
  methodID: string
  refresh: string
  access: string
  expires: number
}

export interface V2IntegrationOAuthAuthorization {
  url: string
  instructions: string
  expiresAt?: number
  mode: 'auto'
  callback: Promise<V2Credential>
}

export interface V2IntegrationEditor {
  update(id: string, update: (integration: { id: string; name: string }) => void): void
  method: {
    update(
      input:
        | {
            integrationID: string
            method: V2IntegrationOAuthMethod
            authorize?: (answer: unknown) => Promise<V2IntegrationOAuthAuthorization>
            refresh?: (credential: unknown) => Promise<unknown>
          }
        | { integrationID: string; method: V2IntegrationEnvMethod }
    ): void
  }
}

export interface V2IntegrationDomain {
  transform(callback: (editor: V2IntegrationEditor) => void): Promise<V2Registration>
  reload(): Promise<void>
  connection: {
    active(integrationID: string): Promise<unknown | undefined>
    resolve(connection: unknown): Promise<unknown | undefined>
    /**
     * Report a connection problem, or `undefined` to clear it. Kiro keeps its own
     * tokens in kiro.db, so the host cannot see one lapse — this is how we say so.
     */
    status(input: {
      integrationID: string
      connection: unknown
      status: V2ConnectionStatus | undefined
    }): Promise<void>
  }
}

/** What the host renders for a connection that needs the user to act. */
export interface V2ConnectionStatus {
  status: 'needs_auth'
  message: string
  /** Where to send them; omit to ask them to reconnect the integration instead. */
  url?: string
}

export type V2SessionHookName = 'http.request' | 'http.response' | 'model.request'

export interface V2SessionHttpRequest {
  readonly sessionID: string
  readonly kind: string
  request: Request
}

export interface V2SessionHttpResponse {
  readonly sessionID: string
  readonly kind: string
  readonly request: Request
  response: Response
}

export interface V2SessionDomain {
  hook(
    name: 'http.request',
    callback: (event: V2SessionHttpRequest) => void | Promise<void>,
    options?: { providerID?: string }
  ): Promise<V2Registration>
  hook(
    name: 'http.response',
    callback: (event: V2SessionHttpResponse) => void | Promise<void>,
    options?: { providerID?: string }
  ): Promise<V2Registration>
}

/**
 * The v2 event envelope, as `packages/schema/src/event.ts` defines it.
 *
 * It carried a `properties` field that does not exist upstream; the real
 * envelope is `{ id, type, created, data, location?, metadata? }`.
 */
export interface V2Event {
  readonly id: string
  readonly type: string
  readonly created: number
  readonly data: unknown
  readonly metadata?: Record<string, unknown>
}

export interface V2EventDomain {
  subscribe(options?: { signal?: AbortSignal }): AsyncIterable<V2Event>
}

export interface V2Location {
  directory: string
  project: { id: string; directory?: string; canonical?: boolean }
  workspaceID?: string
}

/** The narrowed v2 context this plugin binds to. */
export interface V2Context {
  location: V2Location
  options: Record<string, unknown>
  provider: V2ProviderDomain
  model: V2ModelDomain
  integration: V2IntegrationDomain
  session: V2SessionDomain
  event: V2EventDomain
  websearch: V2WebSearchDomain
}

export type V2Cleanup = () => void | Promise<void>
