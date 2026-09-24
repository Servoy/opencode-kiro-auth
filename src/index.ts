import { KiroOAuthPlugin } from './plugin.js'
import { createV2Setup } from './v2/setup.js'

export { authorizeKiroIDC } from './kiro/oauth-idc.js'
export { createKiroPlugin, KiroOAuthPlugin } from './plugin.js'
export type { KiroConfig } from './plugin/config/index.js'
export type { KiroAuthDetails, KiroAuthMethod, KiroRegion, ManagedAccount } from './plugin/types.js'

const KIRO_PROVIDER_ID = 'kiro'

/**
 * Dual entrypoint: v1 hosts call `server()` (the historical plugin), v2 hosts
 * call `setup(ctx)`. The two branches share the same core; only the
 * host-binding layer differs. v1 object-entrypoints need OpenCode >= 1.18.29.
 */
export default {
  id: KIRO_PROVIDER_ID,
  setup: createV2Setup(KIRO_PROVIDER_ID),
  server: KiroOAuthPlugin
}
