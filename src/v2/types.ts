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
  activation: string
  package: string
  settings?: Record<string, unknown>
  headers?: Record<string, string>
}

export interface V2ModelCapabilities {
  tools: boolean
  reasoning?: boolean
  temperature?: boolean
  input: Array<'text' | 'image' | 'pdf'>
  output: ['text']
}

export interface V2ModelVariant {
  id: string
  settings?: Record<string, unknown>
}

export interface V2ModelInfo {
  id: string
  modelID: string
  providerID: string
  name: string
  capabilities: V2ModelCapabilities
  variants: V2ModelVariant[]
  time: { released: number }
  cost: unknown[]
  status: 'active' | 'alpha' | 'beta' | 'deprecated'
  enabled: boolean
  limit: { context: number; output: number }
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

export interface V2ToolExecuteContext {
  signal: AbortSignal
}

export interface V2ToolDefinition {
  name: string
  description: string
  input: unknown
  options?: { codemode?: boolean; namespace?: string }
  execute(input: unknown, context: V2ToolExecuteContext): Promise<{ content: string }>
}

export interface V2ToolEditor {
  add(tool: V2ToolDefinition): void
}

export interface V2ToolDomain {
  transform(callback: (editor: V2ToolEditor) => void): Promise<V2Registration>
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

export interface V2IntegrationOAuthMethod {
  id: string
  type: 'oauth'
  label: string
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
    update(input: {
      integrationID: string
      method: V2IntegrationOAuthMethod
      authorize?: (answer: unknown) => Promise<V2IntegrationOAuthAuthorization>
      refresh?: (credential: unknown) => Promise<unknown>
    }): void
  }
}

export interface V2IntegrationDomain {
  transform(callback: (editor: V2IntegrationEditor) => void): Promise<V2Registration>
  reload(): Promise<void>
  connection: {
    active(integrationID: string): Promise<unknown | undefined>
    resolve(connection: unknown): Promise<unknown | undefined>
  }
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

export interface V2Event {
  readonly type: string
  readonly data?: unknown
  readonly properties?: unknown
}

export interface V2EventDomain {
  subscribe(options?: { signal?: AbortSignal }): AsyncIterable<V2Event>
}

export interface V2Location {
  directory: string
  project: { id: string }
}

/** The narrowed v2 context this plugin binds to. */
export interface V2Context {
  location: V2Location
  options: Record<string, unknown>
  provider: V2ProviderDomain
  model: V2ModelDomain
  tool: V2ToolDomain
  integration: V2IntegrationDomain
  session: V2SessionDomain
  event: V2EventDomain
  websearch: V2WebSearchDomain
}

export type V2Cleanup = () => void | Promise<void>
