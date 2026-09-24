import type { AccountManager } from './accounts.js'
import { summarizeUsage } from './usage.js'

/**
 * The `· NN%` usage suffix appended to model names, or '' when no account has a
 * known limit yet. Kept here (not inline in the v1 hook) so the v2 event loop
 * can reuse the exact same derivation instead of a divergent copy.
 */
export function usageSuffix(accountManager: AccountManager): string {
  const account = accountManager.getAccounts().find((a) => (a.limitCount ?? 0) > 0)
  if (!account) return ''
  const { pct } = summarizeUsage(account.usedCount ?? 0, account.limitCount ?? 0)
  return `· ${pct}%`
}

/**
 * Rewrite the live usage suffix into the registered model names in place.
 *
 * Returns the suffix now in effect so the caller can track it across calls and
 * skip a no-op host reload. `models` is the host's registered model map, keyed
 * however the host keys it; only entries with a string `name` are touched.
 * `previousSuffix` is what was last written, so the swap replaces it rather
 * than stacking a second suffix on the name.
 */
export function applyQuotaSuffix(
  models: Record<string, unknown> | null,
  accountManager: AccountManager,
  previousSuffix: string
): { changed: boolean; suffix: string } {
  if (!models) return { changed: false, suffix: previousSuffix }
  const suffix = usageSuffix(accountManager)
  if (!suffix || suffix === previousSuffix) return { changed: false, suffix: previousSuffix }

  for (const model of Object.values(models)) {
    const entry = model as { name?: string }
    if (typeof entry.name !== 'string') continue
    entry.name = previousSuffix
      ? entry.name.replace(previousSuffix, suffix)
      : `${entry.name} ${suffix}`
  }
  return { changed: true, suffix }
}
