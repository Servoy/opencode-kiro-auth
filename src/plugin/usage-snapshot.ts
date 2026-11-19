import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from './config/paths.js'
import * as logger from './logger.js'
import {
  peekOpenCodeInsights,
  refreshOpenCodeInsights,
  type SessionInsights,
  type TokenTotals,
  type ToolCount
} from './opencode-insights.js'
import { kiroDb, type QuotaInfo } from './storage/sqlite.js'
import type { ManagedAccount } from './types'
import type { UsageResult } from './usage.js'

/** The file name the OpenChamber panel reads for the account-usage snapshot. */
export const USAGE_SNAPSHOT_FILE = 'kiro-usage.json'

/** One account's usage, as written for the panel to render. */
export interface AccountUsageSnapshot {
  id: string
  email: string
  region: string
  used: number
  limit: number
  pct: number
  plan?: string
  planType?: string
  overageStatus?: string
  overageRate?: number
  overageCap?: number
  currentOverages?: number
  unit?: string
  /** Unix ms when the quota resets. */
  resetAt?: number
  daysUntilReset?: number
  isHealthy: boolean
  /** Unix ms this account's usage was last read from AWS. */
  updatedAt: number
}

/** One account's contribution to a session: requests served and credits spent. */
export interface SessionAccountUsageSnapshot {
  accountId: string
  requests: number
  estCredits: number
  firstUsed: number
  lastUsed: number
}

/**
 * One session's usage, summed across every account that served it. A session
 * can rotate across accounts (rate-limit failover, or an explicit switch), so
 * `accounts` carries the per-account breakdown behind the session totals.
 */
export interface SessionUsageSnapshot {
  sessionId: string
  title?: string
  directory?: string
  requests: number
  /**
   * Credits for the session. Rows active since `meteredSince` hold the sum of
   * Kiro's per-response metering; older rows hold the former apportioned estimate.
   */
  estCredits: number
  firstUsed: number
  lastUsed: number
  accounts: SessionAccountUsageSnapshot[]
  /** Kiro tokens over the session and its subagents, from OpenCode. Absent when unreadable. */
  tokens?: TokenTotals
  /** Tool calls by name over the session and its subagents, from OpenCode. */
  tools?: ToolCount[]
  toolCalls?: number
  /** How the session's Kiro turns ended, from OpenCode. */
  turns?: SessionInsights['turns']
}

/** Tool-call totals across every Kiro session in the window, from OpenCode. */
export interface ToolTotalsSnapshot {
  windowDays: number
  totalCalls: number
  items: ToolCount[]
}

/** Token totals across every Kiro session in the window, from OpenCode. */
export interface TokenTotalsSnapshot extends TokenTotals {
  windowDays: number
}

/**
 * A per-account burn total over a fixed window, summed across every session —
 * not just the capped `sessions` list. The panel divides `credits` by the
 * measured span (now − earliestUsed, floored at a day) for an accurate
 * credits/day that does not collapse when there are hundreds of sessions.
 */
export interface BurnTotalSnapshot {
  accountId: string
  windowDays: number
  /**
   * Metered credits of sessions that began at or after `meteredSince`. A lower
   * bound while older sessions are still in the window.
   */
  credits: number
  /** Exact request count over the window, every session included. */
  requests: number
  earliestUsed: number
  /** First activity among the sessions `credits` covers; absent when there are none. */
  creditsSince?: number
  /**
   * How far Kiro's own credit counter for this account moved within the
   * window, from the plugin's recorded readings: the exact credits spent,
   * whatever booked them. Absent when fewer than two readings exist.
   */
  counterDelta?: number
  /** The first counter reading the delta is measured from. */
  counterSince?: number
}

/** One live plugin instance in the pool: its version and where it loaded from. */
export interface PluginInstanceSnapshot {
  pid: number
  version: string
  /** Install path the plugin module loaded from, so a stray copy is locatable. */
  source?: string
  /** Whether this is the instance that wrote this snapshot. */
  self: boolean
  lastSeen: number
}

/**
 * Snapshot schema generation. `version` is the file format (unchanged at 1);
 * `schema` tracks which insight fields are present, so the panel can tell an
 * old plugin that writes none from a current one with nothing to report yet.
 * Bump it when a new insight field is added to the written file.
 */
export const SNAPSHOT_SCHEMA = 2

/** The whole snapshot file: a version marker plus every managed account. */
export interface UsageSnapshotFile {
  version: 1
  /** Insight-field generation; see SNAPSHOT_SCHEMA. Absent on pre-2.11 snapshots. */
  schema?: number
  writtenAt: number
  /** The version of the instance that wrote this file. */
  pluginVersion?: string
  /**
   * Every live plugin instance and its version. OpenCode loads one per project,
   * possibly from different installs, so this exposes a version-split pool the
   * panel can warn about — and which install is on which version.
   */
  pluginInstances: PluginInstanceSnapshot[]
  accounts: AccountUsageSnapshot[]
  /** Recent sessions with request counts and estimated credits (newest first). */
  sessions: SessionUsageSnapshot[]
  /** Distinct sessions active in the burn window; the `sessions` list is capped. */
  sessionsTotal?: number
  /**
   * How session and burn credits are produced: 'metered' sums Kiro's own
   * per-response metering. Absent on snapshots from builds that apportioned.
   */
  creditsSource?: 'metered'
  /**
   * Unix ms this db began metering. `burn` counts only sessions that started at
   * or after it, so until older sessions leave the window, burn is a measured
   * lower bound. A listed session with `firstUsed` before it still carries the
   * former apportioned estimate in its credits.
   */
  meteredSince?: number
  /**
   * Per-account burn totals over a fixed window, across ALL sessions. The
   * `sessions` list is capped for display, so the panel uses this — not that
   * list — to compute credits/day, which otherwise collapsed with many sessions.
   */
  burn: BurnTotalSnapshot[]
  /** Window tool totals; absent when OpenCode's db could not be read. */
  tools?: ToolTotalsSnapshot
  /** Window token totals, all accounts together; absent when OpenCode's db could not be read. */
  tokens?: TokenTotalsSnapshot
}

/** Window the burn totals cover, in days. */
const BURN_WINDOW_DAYS = 7

/**
 * Sessions listed in the snapshot. The credit history in kiro.db spans seven
 * days, which on heavy use is around fifty sessions; an older session has no
 * credit estimate, so listing it would add nothing the panel can show.
 */
export const SNAPSHOT_SESSION_LIMIT = 50

/**
 * The running plugin's version and the path it loaded from, for the panel's
 * outdated / version-split warnings.
 *
 * `plugin.ts` resolves the version once at load (its package.json path differs
 * between the per-file build and the single-file tarball, so it owns that) and
 * registers it here along with the module URL, which locates a stray install.
 */
let registeredPluginVersion: string | undefined
let registeredPluginSource: string | undefined
export function setPluginVersion(version: string, source?: string): void {
  registeredPluginVersion = version
  registeredPluginSource = source
}

export { atomicReplace as _atomicReplaceForTest, type AtomicReplaceFs as _AtomicReplaceFs }

function snapshotPath(): string {
  return join(getConfigDir(), USAGE_SNAPSHOT_FILE)
}

/**
 * Move a freshly-written temp file onto the target, atomically where the OS
 * allows it, and clean up the temp file if it cannot.
 *
 * On POSIX `rename` atomically replaces an existing target, so a reader only
 * ever sees the old or the new complete file. On Windows `rename` throws when
 * the target already exists or a reader has it open (EPERM/EEXIST/EBUSY) — with
 * up to N instances writing and the panel polling, that collision is real. We
 * retry once after removing the target, and if that still loses (another
 * instance won the race, which is fine — its snapshot is equally valid) we drop
 * our temp file so it does not accumulate.
 */
interface AtomicReplaceFs {
  rename(from: string, to: string): void
  remove(path: string): void
}

const realFs: AtomicReplaceFs = {
  rename: renameSync,
  remove: (p) => rmSync(p, { force: true })
}

function atomicReplace(tmp: string, target: string, fs: AtomicReplaceFs = realFs): void {
  try {
    fs.rename(tmp, target)
  } catch {
    try {
      fs.remove(target)
      fs.rename(tmp, target)
    } catch (e) {
      fs.remove(tmp)
      throw e
    }
  }
}

/**
 * Build one account's panel snapshot.
 *
 * Plan, overage and reset come from the fresh `usage` when this write follows a
 * sync, otherwise from `stored`: the details the last sync of any instance kept
 * in kiro.db. Without that fallback a freshly started instance, which writes
 * before its first sync, emptied these fields for every reader until the next
 * sync. Does no I/O.
 *
 * @param account the account
 * @param usage this write's fresh getUsageLimits result, if any
 * @param now current time in ms
 * @param stored the account's quota details from kiro.db, if any
 * @returns the account's entry in the snapshot
 */
export function buildAccountSnapshot(
  account: ManagedAccount,
  usage: UsageResult | undefined,
  now: number,
  stored?: QuotaInfo
): AccountUsageSnapshot {
  const used = Number((usage?.usedCount ?? account.usedCount ?? 0).toFixed(2))
  const limit = Number((usage?.limitCount ?? account.limitCount ?? 0).toFixed(2))
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0
  const fresh = usage ? quotaInfoFromUsage(usage) : {}
  const pick = <K extends keyof QuotaInfo>(k: K): QuotaInfo[K] => fresh[k] ?? stored?.[k]
  const resetAt = pick('resetAt')
  return {
    id: account.id,
    email: usage?.email ?? account.email,
    region: account.region,
    used,
    limit,
    pct,
    plan: pick('plan'),
    planType: pick('planType'),
    overageStatus: pick('overageStatus'),
    overageRate: pick('overageRate'),
    overageCap: pick('overageCap'),
    currentOverages: pick('currentOverages'),
    unit: pick('unit'),
    resetAt,
    // Kiro's own daysUntilReset read 0 with the reset 12 days out, so it is
    // derived from resetAt instead.
    daysUntilReset:
      resetAt !== undefined ? Math.max(0, Math.ceil((resetAt - now) / DAY_MS)) : undefined,
    isHealthy: account.isHealthy,
    updatedAt: account.usageUpdatedAt ?? now
  }
}

/**
 * The quota details of a getUsageLimits result, in the shape kiro.db keeps.
 *
 * @param usage the result
 * @returns the details; a field the result lacks is undefined
 */
export function quotaInfoFromUsage(usage: UsageResult): QuotaInfo {
  return {
    // nextDateReset is Unix seconds; the panel works in ms.
    resetAt:
      typeof usage.nextDateReset === 'number' ? Math.round(usage.nextDateReset * 1000) : undefined,
    plan: usage.subscriptionTitle,
    planType: usage.subscriptionType,
    overageStatus: usage.overageStatus,
    overageRate: usage.overageRate,
    overageCap: usage.overageCap,
    currentOverages: usage.currentOverages,
    unit: usage.unit
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Write the account-usage snapshot for the OpenChamber panel.
 *
 * Every OpenCode project runs its own plugin instance against the shared
 * config dir, so up to N instances may write this file at once. The write is
 * therefore atomic — a per-pid temp file swapped into place via `atomicReplace`
 * — so a reader never sees a half-written file, and last-writer-wins is correct
 * here: the file is a snapshot of one shared account total, and any recent
 * writer holds a valid one. No lock is taken; a lock would only serialise
 * identical snapshots.
 *
 * `usageByAccountId` carries the freshest values from this sync; accounts not
 * in it fall back to their persisted `usedCount`/`limitCount`.
 */
export function writeUsageSnapshot(
  accounts: ManagedAccount[],
  usageByAccountId: Map<string, UsageResult>,
  now: number = Date.now()
): void {
  try {
    const dir = getConfigDir()
    mkdirSync(dir, { recursive: true })
    let sessions: SessionUsageSnapshot[] = []
    let pluginInstances: PluginInstanceSnapshot[] = []
    let burn: BurnTotalSnapshot[] = []
    let sessionsTotal = 0
    let meteredSince: number | undefined
    const burnWindowMs = BURN_WINDOW_DAYS * 24 * 60 * 60 * 1000
    try {
      sessions = kiroDb.getRecentSessionUsage(SNAPSHOT_SESSION_LIMIT)
      sessionsTotal = kiroDb.getSessionsTotal(burnWindowMs, now)
      meteredSince = kiroDb.getMeteredSince()
      const counters = kiroDb.getCounterDeltas(burnWindowMs, now)
      burn = kiroDb.getBurnTotals(burnWindowMs, now, meteredSince ?? 0).map((b) => {
        const c = counters.get(b.accountId)
        return {
          accountId: b.accountId,
          windowDays: BURN_WINDOW_DAYS,
          credits: b.credits,
          requests: b.requests,
          earliestUsed: b.earliestUsed,
          ...(b.measuredEarliestUsed !== undefined ? { creditsSince: b.measuredEarliestUsed } : {}),
          ...(c && c.delta > 0 ? { counterDelta: c.delta, counterSince: c.since } : {})
        }
      })
      if (registeredPluginVersion) {
        kiroDb.heartbeatInstance(registeredPluginVersion, registeredPluginSource)
      }
      pluginInstances = kiroDb.getPluginInstances().map((i) => ({
        pid: i.pid,
        version: i.version,
        source: i.source,
        self: i.pid === process.pid,
        lastSeen: i.lastSeen
      }))
    } catch {
      // A missing/locked store must not stop the account snapshot being written.
    }
    let storedQuota = new Map<string, QuotaInfo>()
    try {
      storedQuota = kiroDb.getQuotaInfo()
    } catch (e) {
      logger.warn('Stored quota details unreadable; snapshot uses fresh usage only', {
        error: e instanceof Error ? e.message : String(e)
      })
    }
    const insights = peekOpenCodeInsights()
    if (insights) {
      for (const s of sessions) {
        const i = insights.sessions.get(s.sessionId)
        if (!i) continue
        s.tokens = i.tokens
        s.tools = i.tools
        s.toolCalls = i.toolCalls
        s.turns = i.turns
      }
    }
    scheduleInsightsRefresh(
      accounts,
      usageByAccountId,
      sessions.map((s) => s.sessionId)
    )
    const file: UsageSnapshotFile = {
      version: 1,
      // Bumped when any insight field below is written, so the panel tells an
      // old plugin (no field) from a genuinely idle one (field present, empty).
      schema: SNAPSHOT_SCHEMA,
      writtenAt: now,
      pluginVersion: registeredPluginVersion,
      pluginInstances,
      accounts: accounts.map((a) =>
        buildAccountSnapshot(a, usageByAccountId.get(a.id), now, storedQuota.get(a.id))
      ),
      sessions,
      sessionsTotal,
      creditsSource: 'metered',
      ...(meteredSince !== undefined ? { meteredSince } : {}),
      burn,
      ...(insights
        ? {
            tools: { windowDays: insights.window.windowDays, ...insights.window.tools },
            tokens: { windowDays: insights.window.windowDays, ...insights.window.tokens }
          }
        : {})
    }
    const target = snapshotPath()
    const tmp = `${target}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(file, null, 2))
    atomicReplace(tmp, target)
  } catch (e) {
    logger.warn('Usage snapshot write failed (non-fatal)', {
      error: e instanceof Error ? e.message : String(e)
    })
  }
}

/**
 * Refresh OpenCode insights off the write path, then rewrite the snapshot once
 * with them. The rewrite is the only one per refresh: refreshOpenCodeInsights
 * returns false while its one-minute cache holds, which ends the loop.
 *
 * @param accounts the accounts the triggering write rendered
 * @param usageByAccountId the fresh usage the triggering write rendered
 * @param rootIds the session ids listed in that write
 */
function scheduleInsightsRefresh(
  accounts: ManagedAccount[],
  usageByAccountId: Map<string, UsageResult>,
  rootIds: string[]
): void {
  void refreshOpenCodeInsights(rootIds, BURN_WINDOW_DAYS)
    .then((changed) => {
      if (changed) writeUsageSnapshot(accounts, usageByAccountId)
    })
    .catch((e: unknown) => {
      logger.warn('OpenCode insights refresh failed (non-fatal)', {
        error: e instanceof Error ? e.message : String(e)
      })
    })
}
