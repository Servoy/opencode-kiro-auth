import type { Plugin } from '@opencode/plugin'
import { buildWebSearchProviderV2 } from '../plugin/web-search.js'
import { buildEnvMethodRegistration, buildIntegrationMethods } from './integration.js'
import { buildV2Provider } from './models-bridge.js'
import type { V2FormStringField, V2SessionHttpResponse } from './types.js'

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
type _IntegrationTransform = OfficialContext['integration']['transform']
type _IntegrationConnActive = OfficialContext['integration']['connection']['active']
type _IntegrationConnResolve = OfficialContext['integration']['connection']['resolve']
type _IntegrationConnStatus = OfficialContext['integration']['connection']['status']
type _SessionHook = OfficialContext['session']['hook']
type _EventSubscribe = OfficialContext['event']['subscribe']
type _LocationDir = OfficialContext['location']['directory']
type _WebSearchTransform = OfficialContext['websearch']['transform']

// Referencing each alias keeps it live under noUnusedLocals-equivalent checks.
export type MirrorConformance = [
  _ProviderTransform,
  _ProviderReload,
  _ModelTransform,
  _ModelReload,
  _IntegrationTransform,
  _IntegrationConnActive,
  _IntegrationConnResolve,
  _IntegrationConnStatus,
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

/**
 * The v2 schema brands its IDs (`Provider.ID`, `Model.ID`, …), which are plain
 * strings at runtime and cannot be constructed without the v2 package this build
 * deliberately does not depend on. Bridged per field so the guard still checks
 * every other property — the whole-shape `as never` it replaced turned the check
 * off rather than narrowing it.
 */
type ProviderID = ProviderAddArg extends { info: { id: infer I } } ? I : never
type IntegrationID = NonNullable<NonNullable<ProviderAddArg['info']>['integrationID']>
type ModelInfo = NonNullable<ProviderAddArg['models']>[number]
type ModelID = ModelInfo['id']
type VariantID = NonNullable<ModelInfo['variants']>[number]['id']
type Cost = NonNullable<ModelInfo['cost']>[number]
type USDPerMTokens = Cost['input']
const branded = <T extends string>(id: string): T => id as T
const usd = (amount: number): USDPerMTokens => amount as USDPerMTokens

const _providerResult = buildV2Provider('kiro', 'https://example/v1', '')
const _providerAddArg: ProviderAddArg = {
  info: {
    ..._providerResult.info,
    id: branded<ProviderID>(_providerResult.info.id),
    integrationID: branded<IntegrationID>(_providerResult.info.integrationID!)
  },
  models: _providerResult.models.map((model) => ({
    ...model,
    id: branded<ModelID>(model.id),
    modelID: branded<ModelID>(model.modelID),
    providerID: branded<ProviderID>(model.providerID),
    variants: model.variants.map((variant) => ({
      ...variant,
      id: branded<VariantID>(variant.id)
    })),
    cost: model.cost.map((tier) => ({
      input: usd(tier.input),
      output: usd(tier.output),
      cache: { read: usd(tier.cache.read), write: usd(tier.cache.write) }
    }))
  }))
}
void _providerAddArg

// The OAuth credential is the one shape that matters and used to go unchecked:
// the method list was built empty and the result cast with `as never`, so the
// guard its own comment described did not exist. Built with a real method now.
const [_oauthMethod] = buildIntegrationMethods('kiro', [
  {
    type: 'oauth',
    label: 'Sign in',
    authorize: async () => ({
      url: 'https://example.invalid/start',
      callback: async () => ({ type: 'failed' as const })
    })
  }
])

// The registration as a whole cannot be assigned here: the official `form` is a
// variadic readonly tuple, while the mirror builds an array of string fields.
// That container needs the v2 package to express, so the rest is guarded field
// by field and the form element by the check below.
type OAuthArm = Extract<MethodUpdateArg, { method: { type: 'oauth' } }>
const _oauthMethodId: OAuthArm['method']['id'] = _oauthMethod!.method.id
const _oauthMethodLabel: OAuthArm['method']['label'] = _oauthMethod!.method.label
void _oauthMethodId
void _oauthMethodLabel

// The env method must assign into the official registration union with no cast.
// It is how a configured KIRO_API_KEY brings the provider up headlessly without
// adding a sign-in picker row; a shape change upstream fails typecheck here.
const _envMethodArg: MethodUpdateArg = buildEnvMethodRegistration('kiro')
void _envMethodArg

// Prove our sign-in form field assigns into the real host method's `form`
// element type. The sign-in bug was a dropped form; if the official OAuth
// method stops accepting a `form`, or renames/retypes its field, this fails
// typecheck and forces a mirror update rather than silently reverting to the
// no-prompts behaviour that sent users to the wrong device page.
type OAuthMethodReg = Extract<MethodUpdateArg, { method: { type: 'oauth' } }>
type HostOAuthMethod = OAuthMethodReg['method']
type HostFormField = NonNullable<HostOAuthMethod['form']>[number]
const _hostFormField: HostFormField = {
  type: 'string',
  key: 'start_url',
  title: 'IAM Identity Center Start URL',
  placeholder: 'https://your-company.awsapps.com/start'
} satisfies V2FormStringField
void _hostFormField

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
