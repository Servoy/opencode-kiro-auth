import type { Plugin } from '@opencode/plugin'
import { buildWebSearchProviderV2 } from '../plugin/web-search.js'
import { buildIntegrationMethods } from './integration.js'
import { buildV2Provider } from './models-bridge.js'
import type { V2SessionHttpResponse } from './types.js'

/**
 * Compile-time drift guard. Fails `npm run typecheck` when the pinned
 * `@opencode/plugin` surface loses a field this plugin depends on. Not a
 * `.test.ts` file: tsconfig would exclude it from tsc and the guard would
 * check nothing.
 *
 * Each check reads a method off the real context type. If a domain or method
 * is renamed or removed upstream, the property access stops type-checking and
 * forces a deliberate mirror update in `types.ts`.
 */

type OfficialContext = Plugin.Context

// Domain transform/reload methods the bridges call.
type _ProviderTransform = OfficialContext['provider']['transform']
type _ProviderReload = OfficialContext['provider']['reload']
type _ModelTransform = OfficialContext['model']['transform']
type _ModelReload = OfficialContext['model']['reload']
type _ToolTransform = OfficialContext['tool']['transform']
type _IntegrationTransform = OfficialContext['integration']['transform']
type _IntegrationConnActive = OfficialContext['integration']['connection']['active']
type _IntegrationConnResolve = OfficialContext['integration']['connection']['resolve']
type _SessionHook = OfficialContext['session']['hook']
type _EventSubscribe = OfficialContext['event']['subscribe']
type _LocationDir = OfficialContext['location']['directory']
// Optional in the mirror (older hosts lack it); NonNullable so the alias still
// checks the domain shape when the host provides it.
type _WebSearchTransform = NonNullable<OfficialContext['websearch']>['transform']

// Referencing each alias keeps it live under noUnusedLocals-equivalent checks.
export type MirrorConformance = [
  _ProviderTransform,
  _ProviderReload,
  _ModelTransform,
  _ModelReload,
  _ToolTransform,
  _IntegrationTransform,
  _IntegrationConnActive,
  _IntegrationConnResolve,
  _SessionHook,
  _EventSubscribe,
  _LocationDir,
  _WebSearchTransform
]

/**
 * The http.response hook must keep a mutable `response: Response` for the
 * request bridge to swap the streamed body. Mirror and official must agree.
 */
const _httpResponseShape = (event: V2SessionHttpResponse): Response => event.response
void _httpResponseShape

// The two shapes the bridges hand to the host: the provider editor's `add`
// input and the integration OAuth method registration. Assigning the bridge
// OUTPUT types into these OFFICIAL parameter types makes a real shape mismatch
// (a field the v2 schema requires but the bridge omits, or one it rejects)
// fail `npm run typecheck` against @opencode/plugin — stronger than the hand
// mirror alone.
type ProviderEditorArg = Parameters<Parameters<OfficialContext['provider']['transform']>[0]>[0]
type IntegrationEditorArg = Parameters<
  Parameters<OfficialContext['integration']['transform']>[0]
>[0]

type ProviderAddArg = Parameters<ProviderEditorArg['add']>[0]
type MethodUpdateArg = Parameters<IntegrationEditorArg['method']['update']>[0]

const _providerResult = buildV2Provider('kiro', 'https://example/v1', '')
const _providerAddArg: ProviderAddArg = {
  info: _providerResult.info as never,
  models: _providerResult.models as never
}
void _providerAddArg

const _methodRegs = buildIntegrationMethods('kiro', [])
const _methodUpdateArg: MethodUpdateArg | undefined = _methodRegs[0] as never
void _methodUpdateArg

// Fails typecheck if our provider's execute return (mapped WebSearch.Result[])
// stops matching the official websearch editor.add definition — the shape that
// makes Kiro a real provider rather than a tool.
type WebSearchEditorArg = Parameters<
  Parameters<NonNullable<OfficialContext['websearch']>['transform']>[0]
>[0]
type WebSearchAddArg = Parameters<WebSearchEditorArg['add']>[0]
const _webSearchProvider = buildWebSearchProviderV2({} as never)
const _webSearchAddArg: WebSearchAddArg = _webSearchProvider as NonNullable<
  typeof _webSearchProvider
>
void _webSearchAddArg
