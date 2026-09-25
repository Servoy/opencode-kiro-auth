import { kiroDb } from '../../plugin/storage/sqlite.js'

type KiroDb = typeof kiroDb

/**
 * Build a kiroDb stub that overrides only the given methods and delegates the
 * rest to the real instance.
 *
 * `mock.module` registers process-globally for the whole bun run, not just the
 * file that calls it, so a hand-listed stub that misses a method silently
 * strands a *different* file that runs later — the usage-sync lock methods
 * vanished this way and broke CI. Chaining onto the real kiroDb via its
 * prototype (under NODE_ENV=test that instance lives on a per-pid throwaway
 * tmpdir SQLite) keeps every unlisted method resolving to the real one. A plain
 * spread would drop the prototype methods, which is exactly the trap.
 */
export function makeKiroDbStub(overrides: Partial<KiroDb>): KiroDb {
  return Object.assign(Object.create(kiroDb), overrides)
}
