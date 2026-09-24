import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { KiroDatabase } from '../plugin/storage/sqlite.js'

/**
 * Cross-instance safety: kiroDb is a process-global singleton shared by
 * every OpenChamber project on the same machine. Before this fix,
 * kiroDb.close() tore down the shared connection; any concurrent query
 * from a sibling instance then crashed with "Cannot use a closed database"
 * — 56 of those in the live log across 15 OpenChamber projects.
 *
 * The fix: kiroDb.close() is now a no-op. WAL mode keeps the file's
 * resources managed by SQLite itself; process shutdown handles cleanup.
 *
 * This test exercises a real KiroDatabase instance (not the singleton, so
 * it isn't replaced by an incomplete mock in accounts.test.ts) and proves
 * close() is harmless: subsequent queries still succeed.
 */
describe('KiroDatabase: dispose does not break subsequent queries', () => {
  let db: KiroDatabase

  beforeEach(() => {
    db = new KiroDatabase()
  })

  afterEach(() => {
    // Best-effort cleanup; the singleton lives across all tests anyway.
    try {
      db.close()
    } catch {
      // close is now a no-op; nothing to do if it ever throws
    }
  })

  test('a query after close() still succeeds (the connection stays alive)', () => {
    expect(Array.isArray(db.getAccounts())).toBe(true)
    db.close()
    // Post-fix: this just runs because close() no longer destroys the
    // connection. Pre-fix: this throws "Cannot use a closed database".
    expect(() => db.getAccounts()).not.toThrow()
    expect(Array.isArray(db.getAccounts())).toBe(true)
  })

  test('repeated close() calls are safe', () => {
    db.close()
    db.close()
    db.close()
    expect(() => db.getAccounts()).not.toThrow()
  })
})
