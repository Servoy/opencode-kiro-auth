import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from './config/paths.js'
import * as logger from './logger.js'
import { kiroDb } from './storage/sqlite.js'
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
  /** Estimated credits, apportioned per account from that account's deltas by request share. */
  estCredits: number
  firstUsed: number
  lastUsed: number
  accounts: SessionAccountUsageSnapshot[]
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

/** The whole snapshot file: a version marker plus every managed account. */
export interface UsageSnapshotFile {
  version: 1
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
}

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
 * Build one account's panel snapshot from its live usage fields.
 *
 * Does no I/O so a test can assert the mapping — plan, overage, the seconds→ms
 * reset conversion — without touching disk. Caches a fresh `nextDateReset` back
 * onto `account.resetAt` so a later sync that omits it can still show the date.
 */
export function buildAccountSnapshot(
  account: ManagedAccount,
  usage: UsageResult | undefined,
  now: number
): AccountUsageSnapshot {
  const used = Number((usage?.usedCount ?? account.usedCount ?? 0).toFixed(2))
  const limit = Number((usage?.limitCount ?? account.limitCount ?? 0).toFixed(2))
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0
  // nextDateReset is Unix seconds; the panel works in ms. Some param
  // combinations omit it, so reuse the account's last value to avoid flicker.
  const resetMs =
    typeof usage?.nextDateReset === 'number'
      ? Math.round(usage.nextDateReset * 1000)
      : account.resetAt
  if (resetMs) account.resetAt = resetMs
  return {
    id: account.id,
    email: usage?.email ?? account.email,
    region: account.region,
    used,
    limit,
    pct,
    plan: usage?.subscriptionTitle,
    planType: usage?.subscriptionType,
    overageStatus: usage?.overageStatus,
    overageRate: usage?.overageRate,
    overageCap: usage?.overageCap,
    currentOverages: usage?.currentOverages,
    unit: usage?.unit,
    resetAt: resetMs,
    daysUntilReset: usage?.daysUntilReset,
    isHealthy: account.isHealthy,
    updatedAt: account.usageUpdatedAt ?? now
  }
}

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
    try {
      sessions = kiroDb.getRecentSessionUsage(20)
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
    const file: UsageSnapshotFile = {
      version: 1,
      writtenAt: now,
      pluginVersion: registeredPluginVersion,
      pluginInstances,
      accounts: accounts.map((a) => buildAccountSnapshot(a, usageByAccountId.get(a.id), now)),
      sessions
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
