import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as logger from './logger.js'
import { openDatabase, type SqliteDatabase } from './storage/database-driver.js'

/**
 * Per-session and windowed usage insights, read from OpenCode's own database.
 *
 * OpenCode already stores every assistant message with its token counts,
 * finish reason and tool parts (`session_message`), and the session tree
 * (`session_v2.parent_id`). The plugin reads that read-only instead of
 * capturing a second copy: the snapshot summary is recomputed from the source,
 * so nothing is held between runs, nothing double-counts across project
 * instances, and a restart loses no history.
 *
 * Only messages whose `model.providerID` is `kiro` count. Subagent sessions are
 * folded into their root, because the plugin books a subagent's requests under
 * the root session id it receives in the request header.
 *
 * Every read is best-effort: any failure (no db, schema change, lock) returns
 * nothing and the panel shows the fields as "not reported".
 */

/** Token totals summed over Kiro assistant messages. */
export interface TokenTotals {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Messages whose tokens were reported; the totals cover exactly these. */
  reportedRequests: number
}

/** One tool and how often it was called. */
export interface ToolCount {
  name: string
  count: number
}

/** How assistant turns ended: with tool calls, as a plain answer, or with an error. */
export interface TurnMix {
  toolUse: number
  answer: number
  error: number
}

/** One root session's insights, summed over the root and all its subagents. */
export interface SessionInsights {
  tokens: TokenTotals
  tools: ToolCount[]
  toolCalls: number
  turns: TurnMix
}

/** Windowed totals across every Kiro session, for the panel's aggregate blocks. */
export interface WindowInsights {
  windowDays: number
  tokens: TokenTotals
  tools: { totalCalls: number; items: ToolCount[] }
}

/** Everything one snapshot needs from OpenCode, keyed by root session id. */
export interface OpenCodeInsights {
  sessions: Map<string, SessionInsights>
  window: WindowInsights
}

/** One Kiro assistant message, reduced to the fields the summary needs. */
export interface MessageRow {
  sessionId: string
  timeCreated: number
  finish: string | null
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  tokensReported: boolean
  tools: string[]
}

const RESOLVE_TIMEOUT_MS = 3000
/** The read takes a few hundred ms on a busy db; snapshots fire several times a minute. */
const CACHE_MS = 60_000
/** Children can outlive their root's last update; pull them a day further back. */
const TREE_SLACK_MS = 24 * 60 * 60 * 1000

let dbPathPromise: Promise<string | undefined> | undefined
let cached: { at: number; key: string; value: OpenCodeInsights | undefined } | undefined

/**
 * Where OpenCode keeps its database, as `opencode debug paths` reports it.
 *
 * Asking OpenCode itself follows its release channel, `OPENCODE_DB` and the
 * per-OS data dir without this plugin re-implementing any of that. Resolved
 * once per process. Undefined when the command is missing or reports no db.
 *
 * @returns the absolute db path, or undefined
 */
export function resolveOpenCodeDbPath(): Promise<string | undefined> {
  if (process.env.OPENCODE_DB) return Promise.resolve(process.env.OPENCODE_DB)
  // Tests must never read the developer's real OpenCode history; they point OPENCODE_DB at a fixture.
  if (process.env.NODE_ENV === 'test') return Promise.resolve(undefined)
  dbPathPromise ??= new Promise((resolve) => {
    execFile(
      'opencode',
      ['debug', 'paths'],
      { timeout: RESOLVE_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err) {
          logger.warn('OpenCode db path not resolved; session insights disabled', {
            error: err.message
          })
          resolve(undefined)
          return
        }
        resolve(parseDbPath(String(stdout)))
      }
    )
  })
  return dbPathPromise
}

/**
 * The `db` line of `opencode debug paths` output.
 *
 * @param output the command's stdout
 * @returns the db path, or undefined when no `db` line is present
 */
export function parseDbPath(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const m = /^db\s+(.+?)\s*$/.exec(line)
    if (m?.[1]) return m[1]
  }
  return undefined
}

/**
 * The last insights read, without reading. The snapshot writer is synchronous
 * and must never wait on OpenCode's db, so it renders whatever is cached and
 * lets {@link refreshOpenCodeInsights} bring it up to date in the background.
 *
 * @returns the cached insights, or undefined before the first successful read
 */
export function peekOpenCodeInsights(): OpenCodeInsights | undefined {
  return cached?.value
}

/**
 * Re-read insights when the cache is older than a minute or covers other sessions.
 *
 * @param rootIds root session ids to report on (the snapshot's session list)
 * @param windowDays the window for the aggregate totals
 * @param now current time in ms
 * @returns true when a new read replaced the cache, false when the cache was still fresh
 */
export async function refreshOpenCodeInsights(
  rootIds: string[],
  windowDays: number,
  now = Date.now()
): Promise<boolean> {
  const dbPath = await resolveOpenCodeDbPath()
  if (!dbPath || !existsSync(dbPath)) return false
  const key = `${dbPath}|${windowDays}|${rootIds.join(',')}`
  if (cached && cached.key === key && now - cached.at < CACHE_MS) return false
  // Claim the slot before reading so a burst of snapshots triggers one read, not many.
  cached = { at: now, key, value: cached?.value }
  const value = readInsights(dbPath, rootIds, windowDays, now)
  cached = { at: now, key, value }
  return value !== undefined
}

/** Test-only: forget the resolved path and the cached read. */
export function resetOpenCodeInsightsForTest(): void {
  dbPathPromise = undefined
  cached = undefined
}

/**
 * Read insights from an OpenCode database file, read-only.
 *
 * One indexed scan of the window's assistant messages plus the session tree;
 * the folding into roots happens in {@link summarize}.
 *
 * @param dbPath path to opencode.db
 * @param rootIds root session ids to report on
 * @param windowDays the window for the aggregate totals
 * @param now current time in ms
 * @returns the insights, or undefined on any read failure
 */
export function readInsights(
  dbPath: string,
  rootIds: string[],
  windowDays: number,
  now = Date.now()
): OpenCodeInsights | undefined {
  let db: SqliteDatabase | undefined
  try {
    db = openDatabase(dbPath, { readonly: true })
    // OpenCode holds this db open and writes to it; never wait long on its locks.
    db.exec('PRAGMA busy_timeout = 1000')
    const since = now - windowDays * 24 * 60 * 60 * 1000
    const parents = readParents(db, since - TREE_SLACK_MS)
    const messages = readMessages(db, since - TREE_SLACK_MS)
    return summarize(messages, parents, rootIds, since, windowDays)
  } catch (e) {
    logger.warn('OpenCode session insights read failed; fields omitted from the snapshot', {
      error: e instanceof Error ? e.message : String(e)
    })
    return undefined
  } finally {
    try {
      db?.close()
    } catch {
      // closing a read-only handle cannot lose data
    }
  }
}

function readParents(db: SqliteDatabase, since: number): Map<string, string> {
  const rows = db
    .prepare(
      'SELECT id, parent_id FROM session_v2 WHERE parent_id IS NOT NULL AND time_updated >= ?'
    )
    .all(since) as Array<{ id: string; parent_id: string }>
  return new Map(rows.map((r) => [r.id, r.parent_id]))
}

function readMessages(db: SqliteDatabase, since: number): MessageRow[] {
  const rows = db
    .prepare(
      `SELECT m.session_id AS sid,
              m.time_created AS created,
              json_extract(m.data, '$.finish') AS finish,
              json_type(m.data, '$.tokens') AS tokens_type,
              json_extract(m.data, '$.tokens.input') AS ti,
              json_extract(m.data, '$.tokens.output') AS tout,
              json_extract(m.data, '$.tokens.cache.read') AS tcr,
              json_extract(m.data, '$.tokens.cache.write') AS tcw,
              (SELECT json_group_array(json_extract(p.value, '$.name'))
                 FROM json_each(m.data, '$.content') p
                WHERE json_extract(p.value, '$.type') = 'tool') AS tools
         FROM session_message m
        WHERE m.type = 'assistant'
          AND m.time_created >= ?
          AND json_extract(m.data, '$.model.providerID') = 'kiro'`
    )
    .all(since) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    sessionId: String(r.sid),
    timeCreated: Number(r.created) || 0,
    finish: typeof r.finish === 'string' ? r.finish : null,
    input: Number(r.ti) || 0,
    output: Number(r.tout) || 0,
    cacheRead: Number(r.tcr) || 0,
    cacheWrite: Number(r.tcw) || 0,
    tokensReported: r.tokens_type === 'object',
    tools: parseToolNames(r.tools)
  }))
}

function parseToolNames(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((n): n is string => typeof n === 'string') : []
  } catch {
    return []
  }
}

/**
 * Fold Kiro assistant messages into per-root session insights and window totals.
 *
 * Pure: no I/O, so it is tested directly with hand-made rows.
 *
 * @param messages Kiro assistant messages, possibly from before the window
 * @param parents child session id → parent session id
 * @param rootIds root sessions to report on
 * @param since start of the aggregate window, ms
 * @param windowDays the window length, echoed into the result
 * @returns per-root insights (only roots with at least one Kiro message) and window totals
 */
export function summarize(
  messages: MessageRow[],
  parents: Map<string, string>,
  rootIds: string[],
  since: number,
  windowDays: number
): OpenCodeInsights {
  const wanted = new Set(rootIds)
  const rootOf = (id: string): string => {
    let cur = id
    // Bounded walk: a cycle in a corrupt tree must not hang the snapshot.
    for (let i = 0; i < 16; i++) {
      const p = parents.get(cur)
      if (!p) return cur
      cur = p
    }
    return cur
  }

  const sessions = new Map<string, SessionInsights>()
  const sessionTools = new Map<string, Map<string, number>>()
  const window = emptyTokens()
  const windowTools = new Map<string, number>()

  for (const m of messages) {
    if (m.timeCreated >= since) {
      addTokens(window, m)
      for (const t of m.tools) windowTools.set(t, (windowTools.get(t) ?? 0) + 1)
    }
    const root = rootOf(m.sessionId)
    if (!wanted.has(root)) continue
    let s = sessions.get(root)
    if (!s) {
      s = {
        tokens: emptyTokens(),
        tools: [],
        toolCalls: 0,
        turns: { toolUse: 0, answer: 0, error: 0 }
      }
      sessions.set(root, s)
      sessionTools.set(root, new Map())
    }
    addTokens(s.tokens, m)
    if (m.finish === 'tool-calls') s.turns.toolUse++
    else if (m.finish === 'stop') s.turns.answer++
    else if (m.finish === 'error') s.turns.error++
    const tools = sessionTools.get(root)!
    for (const t of m.tools) tools.set(t, (tools.get(t) ?? 0) + 1)
  }

  for (const [root, s] of sessions) {
    s.tools = toCounts(sessionTools.get(root)!)
    s.toolCalls = s.tools.reduce((n, t) => n + t.count, 0)
  }
  const items = toCounts(windowTools)
  return {
    sessions,
    window: {
      windowDays,
      tokens: window,
      tools: { totalCalls: items.reduce((n, t) => n + t.count, 0), items }
    }
  }
}

function emptyTokens(): TokenTotals {
  return {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reportedRequests: 0
  }
}

function addTokens(into: TokenTotals, m: MessageRow): void {
  if (!m.tokensReported) return
  into.uncachedInputTokens += m.input
  into.outputTokens += m.output
  into.cacheReadTokens += m.cacheRead
  into.cacheWriteTokens += m.cacheWrite
  into.reportedRequests++
}

function toCounts(map: Map<string, number>): ToolCount[] {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}
