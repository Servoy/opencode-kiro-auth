import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseDbPath,
  peekOpenCodeInsights,
  readInsights,
  refreshOpenCodeInsights,
  resetOpenCodeInsightsForTest,
  summarize,
  type MessageRow
} from '../plugin/opencode-insights.js'
import { openDatabase } from '../plugin/storage/database-driver.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

/**
 * A fixture opencode.db with the two tables the reader touches, shaped like
 * OpenCode 2.0.29 writes them. Messages carry the same JSON keys a real
 * assistant message has: model.providerID, finish, tokens, content[].
 */
function fixtureDb(): { dir: string; path: string; add: (row: FixtureMessage) => void } {
  const dir = mkdtempSync(join(tmpdir(), 'kiro-ocdb-'))
  const path = join(dir, 'opencode.db')
  const db = openDatabase(path)
  db.exec(
    `CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, time_updated INTEGER NOT NULL)`
  )
  db.exec(`CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
    time_created INTEGER NOT NULL, data TEXT NOT NULL)`)
  let n = 0
  const sessions = new Set<string>()
  return {
    dir,
    path,
    add(row) {
      if (!sessions.has(row.session)) {
        db.prepare('INSERT INTO session_v2 (id, parent_id, time_updated) VALUES (?, ?, ?)').run(
          row.session,
          row.parent ?? null,
          row.at ?? NOW
        )
        sessions.add(row.session)
      }
      const data = {
        model: { id: 'auto', providerID: row.provider ?? 'kiro' },
        ...(row.finish ? { finish: row.finish } : {}),
        ...(row.tokens === false
          ? {}
          : {
              tokens: {
                input: row.input ?? 100,
                output: row.output ?? 10,
                reasoning: 0,
                cache: { read: 0, write: 0 }
              }
            }),
        content: (row.tools ?? []).map((name) => ({
          type: 'tool',
          name,
          state: { input: { secret: 'x' } }
        }))
      }
      db.prepare(
        'INSERT INTO session_message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)'
      ).run(`m${n++}`, row.session, row.type ?? 'assistant', row.at ?? NOW, JSON.stringify(data))
    }
  }
}

interface FixtureMessage {
  session: string
  parent?: string
  provider?: string
  type?: string
  finish?: string
  tokens?: false
  input?: number
  output?: number
  tools?: string[]
  at?: number
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  delete process.env.OPENCODE_DB
  resetOpenCodeInsightsForTest()
})

describe('readInsights against an OpenCode-shaped db', () => {
  test('folds subagent sessions into their root, matching the requests the plugin books', () => {
    const f = fixtureDb()
    dirs.push(f.dir)
    f.add({ session: 'root', finish: 'tool-calls', tools: ['read'], input: 1000, output: 50 })
    f.add({ session: 'root', finish: 'stop', input: 2000, output: 60 })
    f.add({
      session: 'child',
      parent: 'root',
      finish: 'tool-calls',
      tools: ['shell', 'read'],
      input: 500,
      output: 5
    })
    f.add({ session: 'child', parent: 'root', finish: 'error', input: 300, output: 1 })

    const r = readInsights(f.path, ['root'], 7, NOW)!
    const s = r.sessions.get('root')!
    expect(s.tokens).toEqual({
      uncachedInputTokens: 3800,
      outputTokens: 116,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reportedRequests: 4
    })
    expect(s.turns).toEqual({ toolUse: 2, answer: 1, error: 1 })
    expect(s.toolCalls).toBe(3)
    expect(s.tools).toEqual([
      { name: 'read', count: 2 },
      { name: 'shell', count: 1 }
    ])
    // The child is folded in, never reported as its own session.
    expect(r.sessions.has('child')).toBe(false)
  })

  test('counts only Kiro messages, so another provider never inflates Kiro usage', () => {
    const f = fixtureDb()
    dirs.push(f.dir)
    f.add({ session: 's', finish: 'stop', input: 100, tools: ['read'] })
    f.add({
      session: 's',
      provider: 'minimax-coding-plan',
      finish: 'stop',
      input: 9999,
      tools: ['shell']
    })

    const r = readInsights(f.path, ['s'], 7, NOW)!
    expect(r.sessions.get('s')!.tokens.uncachedInputTokens).toBe(100)
    expect(r.sessions.get('s')!.tools).toEqual([{ name: 'read', count: 1 }])
    expect(r.window.tools.items).toEqual([{ name: 'read', count: 1 }])
  })

  test('window totals cover every Kiro session in the window, not just the listed ones', () => {
    const f = fixtureDb()
    dirs.push(f.dir)
    f.add({ session: 'listed', finish: 'stop', input: 10, tools: ['read'] })
    f.add({ session: 'unlisted', finish: 'stop', input: 20, tools: ['edit', 'edit'] })
    f.add({ session: 'old', finish: 'stop', input: 40, tools: ['grep'], at: NOW - 10 * DAY })

    const r = readInsights(f.path, ['listed'], 7, NOW)!
    expect(r.window.windowDays).toBe(7)
    expect(r.window.tokens.uncachedInputTokens).toBe(30)
    expect(r.window.tokens.reportedRequests).toBe(2)
    expect(r.window.tools).toEqual({
      totalCalls: 3,
      items: [
        { name: 'edit', count: 2 },
        { name: 'read', count: 1 }
      ]
    })
  })

  test('a message without reported tokens counts as a turn but not toward the token totals', () => {
    const f = fixtureDb()
    dirs.push(f.dir)
    f.add({ session: 's', finish: 'stop', input: 100 })
    f.add({ session: 's', finish: 'tool-calls', tokens: false, tools: ['read'] })

    const s = readInsights(f.path, ['s'], 7, NOW)!.sessions.get('s')!
    expect(s.tokens.reportedRequests).toBe(1)
    expect(s.tokens.uncachedInputTokens).toBe(100)
    expect(s.turns).toEqual({ toolUse: 1, answer: 1, error: 0 })
  })

  test('a running message (no finish yet) is counted in no turn bucket', () => {
    const f = fixtureDb()
    dirs.push(f.dir)
    f.add({ session: 's' })
    expect(readInsights(f.path, ['s'], 7, NOW)!.sessions.get('s')!.turns).toEqual({
      toolUse: 0,
      answer: 0,
      error: 0
    })
  })

  test('a db without the expected schema yields undefined rather than throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiro-ocdb-'))
    dirs.push(dir)
    const path = join(dir, 'opencode.db')
    openDatabase(path).exec('CREATE TABLE unrelated (x INTEGER)')
    expect(readInsights(path, ['s'], 7, NOW)).toBeUndefined()
  })

  test('opens the db read-only: the reader never writes to OpenCode', () => {
    const f = fixtureDb()
    dirs.push(f.dir)
    f.add({ session: 's', finish: 'stop' })
    readInsights(f.path, ['s'], 7, NOW)
    const rows = openDatabase(f.path, { readonly: true })
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>
    expect(rows.map((r) => r.name)).toEqual(['session_message', 'session_v2'])
  })
})

describe('summarize', () => {
  const row = (over: Partial<MessageRow>): MessageRow => ({
    sessionId: 's',
    timeCreated: NOW,
    finish: 'stop',
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    tokensReported: true,
    tools: [],
    ...over
  })

  test('a parent cycle ends the walk instead of hanging the snapshot', () => {
    const parents = new Map([
      ['a', 'b'],
      ['b', 'a']
    ])
    const r = summarize([row({ sessionId: 'a' })], parents, ['a', 'b'], 0, 7)
    expect(r.sessions.size).toBe(1)
  })

  test('messages before the window feed a listed session but not the window totals', () => {
    const r = summarize(
      [row({ timeCreated: NOW - 8 * DAY, input: 5 })],
      new Map(),
      ['s'],
      NOW - 7 * DAY,
      7
    )
    expect(r.sessions.get('s')!.tokens.uncachedInputTokens).toBe(5)
    expect(r.window.tokens.reportedRequests).toBe(0)
  })
})

describe('parseDbPath', () => {
  test('reads the db line of `opencode debug paths`', () => {
    const out =
      'home       /Users/x\ndata       /Users/x/.local/share/opencode\ndb         /Users/x/.local/share/opencode/opencode.db\n'
    expect(parseDbPath(out)).toBe('/Users/x/.local/share/opencode/opencode.db')
  })

  test('keeps a Windows path with spaces intact', () => {
    expect(parseDbPath('db   C:\\Users\\A B\\AppData\\opencode\\opencode.db\r\n')).toBe(
      'C:\\Users\\A B\\AppData\\opencode\\opencode.db'
    )
  })

  test('is undefined when there is no db line', () => {
    expect(parseDbPath('home /Users/x\n')).toBeUndefined()
  })
})

describe('refreshOpenCodeInsights', () => {
  test('reads OPENCODE_DB, caches for a minute, and re-reads when the session list changes', async () => {
    const f = fixtureDb()
    dirs.push(f.dir)
    f.add({ session: 's', finish: 'stop', input: 7 })
    process.env.OPENCODE_DB = f.path

    expect(peekOpenCodeInsights()).toBeUndefined()
    expect(await refreshOpenCodeInsights(['s'], 7, NOW)).toBe(true)
    expect(peekOpenCodeInsights()!.sessions.get('s')!.tokens.uncachedInputTokens).toBe(7)

    expect(await refreshOpenCodeInsights(['s'], 7, NOW + 30_000)).toBe(false)
    expect(await refreshOpenCodeInsights(['s', 't'], 7, NOW + 30_000)).toBe(true)
    expect(await refreshOpenCodeInsights(['s', 't'], 7, NOW + 120_000)).toBe(true)
  })

  test('under test with no OPENCODE_DB it reads nothing, keeping real history out of tests', async () => {
    expect(await refreshOpenCodeInsights(['s'], 7, NOW)).toBe(false)
    expect(peekOpenCodeInsights()).toBeUndefined()
  })
})
