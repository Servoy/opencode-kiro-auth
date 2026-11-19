/**
 * Choosing another model when the one asked for has no capacity.
 *
 * The Kiro CLI moves a turn to a different model when the backend reports it
 * cannot serve the one in use, and keeps that separable from a safety refusal.
 * Only the capacity half is ported here: re-routing a refusal is shopping for
 * a model that will answer, which is not a decision a provider plugin should
 * make on the user's behalf.
 *
 * Every function here is pure — the catalog is passed in — so one runner can
 * exercise the policy without a loaded account.
 */

/**
 * One step down inside the same family, for the models Kiro serves more than
 * one of. Same family and the same rate multiplier, so a fallback never
 * quietly changes what the turn costs; anything that crosses a family (opus to
 * sonnet) is a judgement about quality and price and stays opt-in through
 * `model_fallbacks`.
 */
export const DEFAULT_MODEL_FALLBACKS: Record<string, string[]> = {
  'claude-opus-5-5': ['claude-opus-5'],
  'claude-opus-5': ['claude-opus-4-8'],
  'claude-opus-4-8': ['claude-opus-4-7'],
  'claude-sonnet-5-5': ['claude-sonnet-5'],
  'claude-sonnet-5': ['claude-sonnet-4-6'],
  'claude-haiku-5-5': ['claude-haiku-4-5']
}

const THINKING_SUFFIX = '-thinking'

/**
 * A failure that blames the model rather than the account or the service.
 *
 * Throttling and plain 5xx are deliberately absent: those are about this
 * account or Kiro as a whole, and answering them by changing model spends a
 * second model's capacity on a problem it cannot fix.
 */
export function isModelCapacityError(reason?: string): boolean {
  if (!reason) return false
  const r = reason.toLowerCase().replace(/[_\s-]/g, '')
  return (
    r.includes('modeltemporarilyunavailable') ||
    r.includes('insufficientmodelcapacity') ||
    r.includes('modelnotavailable') ||
    r.includes('modelunavailable') ||
    r.includes('nocapacity')
  )
}

/**
 * The next model to try, or undefined to let the failure stand.
 *
 * Walks the chain configured for `model`, skipping anything already attempted
 * — which is also what stops a chain that loops back on itself — and anything
 * the account is not served. Chains are followed one hop at a time: the caller
 * re-enters with the new model, so that model's own chain carries on from
 * there without this having to flatten them.
 *
 * The answer is recorded in `tried` here rather than by the caller. Leaving
 * that to the caller made termination depend on remembering to do it, and the
 * first caller that forgot walked a self-referencing chain forever.
 *
 * @param tried every model this request has already been refused by, the
 *   current one included; extended with the model returned
 * @param isServed whether the account's catalog offers a model; a catalog that
 *   has not been read yet must answer true, since an unread catalog is not a no
 */
export function nextFallbackModel(
  model: string,
  chains: Record<string, string[]>,
  tried: Set<string>,
  isServed: (model: string) => boolean
): string | undefined {
  const thinking = model.endsWith(THINKING_SUFFIX)
  const base = thinking ? model.slice(0, -THINKING_SUFFIX.length) : model

  const chain = chains[base] ?? chains[model]
  if (!chain) return undefined

  for (const target of chain) {
    // A chain written against base ids still has to answer a thinking request
    // with a thinking model, or the fallback silently drops reasoning.
    const candidate =
      thinking && !target.endsWith(THINKING_SUFFIX) ? `${target}${THINKING_SUFFIX}` : target
    if (tried.has(candidate) || tried.has(target)) continue
    if (!isServed(candidate)) continue
    tried.add(candidate)
    return candidate
  }
  return undefined
}
