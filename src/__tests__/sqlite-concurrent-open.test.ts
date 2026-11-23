import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Opens the real KiroDatabase in a separate process, as a second OpenCode
// instance would, while this process holds the write lock. In-process
// connections share SQLite's lock state differently, so only a second
// process reproduces the failed plugin load.

const dir = mkdtempSync(join(tmpdir(), 'kiro-concurrent-'))
const dbPath = join(dir, 'kiro.db')
const storage = join(import.meta.dir, '../plugin/storage/sqlite.ts')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Open the db in a child process; resolves to its one-line verdict. */
async function openInChild(): Promise<string> {
  const child = Bun.spawn(
    [
      'bun',
      '-e',
      `const { KiroDatabase } = await import(${JSON.stringify(storage)})
       try { new KiroDatabase(${JSON.stringify(dbPath)}); console.log('opened') }
       catch (e) { console.log('failed: ' + e.message) }`
    ],
    { env: { ...process.env, NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'inherit' }
  )
  const out = await new Response(child.stdout).text()
  await child.exited
  return out.trim().split('\n').pop() ?? ''
}

describe('opening kiro.db while another instance writes', () => {
  test('waits for the writer instead of failing the plugin load', async () => {
    // A first instance creates the schema, as on any machine already in use.
    expect(await openInChild()).toBe('opened')

    const writer = new Database(dbPath)
    writer.exec('BEGIN IMMEDIATE')
    const released = new Promise<void>((resolve) =>
      setTimeout(() => {
        writer.exec('COMMIT')
        writer.close()
        resolve()
      }, 1_000)
    )

    const verdict = await openInChild()
    await released
    expect(verdict).toBe('opened')
  }, 20_000)
})
