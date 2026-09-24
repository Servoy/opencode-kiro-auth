import { KiroOAuthPlugin } from './src/plugin'
import { createV2Setup } from './src/v2/setup'

export { authorizeKiroIDC } from './src/kiro/oauth-idc'
export { createKiroPlugin, KiroOAuthPlugin } from './src/plugin'
export type { KiroConfig } from './src/plugin/config'
export type {
  KiroAuthDetails,
  KiroAuthMethod,
  KiroRegion,
  ManagedAccount
} from './src/plugin/types'

const KIRO_PROVIDER_ID = 'kiro'

/**
 * Dual entrypoint: v1 hosts call `server()`, v2 hosts call `setup(ctx)`.
 * Mirrors `src/index.ts` (the built package entry); this root file is the
 * source/dev entry.
 */
export default {
  id: KIRO_PROVIDER_ID,
  setup: createV2Setup(KIRO_PROVIDER_ID),
  server: KiroOAuthPlugin
}
