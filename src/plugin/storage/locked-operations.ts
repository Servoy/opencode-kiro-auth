import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import lockfile from 'proper-lockfile'
import { isPermanentError } from '../health'
import type { ManagedAccount } from '../types'

const LOCK_OPTIONS = {
  stale: 10000,
  retries: {
    retries: 5,
    minTimeout: 100,
    maxTimeout: 1000,
    factor: 2
  },
  realpath: false
}

// In-process serialisation: prevents concurrent writes within the same process
// from racing each other without paying the file-lock cost on every request.
let inProcessLockChain: Promise<void> = Promise.resolve()

export async function withDatabaseLock<T>(dbPath: string, fn: () => Promise<T>): Promise<T> {
  // Serialise within this process first (cheap).
  let resolveInProcess!: () => void
  const prev = inProcessLockChain
  inProcessLockChain = new Promise<void>((r) => (resolveInProcess = r))
  await prev

  if (!existsSync(dbPath)) {
    const dir = dbPath.substring(0, dbPath.lastIndexOf('/'))
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(dbPath, '')
  }

  let release: (() => Promise<void>) | null = null
  try {
    release = await lockfile.lock(dbPath, LOCK_OPTIONS)
    return await fn()
  } finally {
    if (release) {
      try {
        await release()
      } catch (e) {
        console.warn('Failed to release lock:', e)
      }
    }
    resolveInProcess()
  }
}

export function createDeterministicId(
  email: string,
  authMethod: string,
  clientId?: string,
  profileArn?: string
): string {
  const parts = [email, authMethod, clientId || '', profileArn || ''].join(':')
  return createHash('sha256').update(parts).digest('hex')
}

export function mergeAccounts(
  existing: ManagedAccount[],
  incoming: ManagedAccount[]
): ManagedAccount[] {
  const accountMap = new Map<string, ManagedAccount>()

  for (const acc of existing) {
    accountMap.set(acc.id, acc)
  }

  for (const acc of incoming) {
    const existingAcc = accountMap.get(acc.id)

    if (existingAcc) {
      const incomingHasPermanentError = isPermanentError(acc.unhealthyReason)
      const hasPermanentError =
        isPermanentError(existingAcc.unhealthyReason) || incomingHasPermanentError
      const incomingRecovered = acc.isHealthy && !incomingHasPermanentError

      accountMap.set(acc.id, {
        ...existingAcc,
        ...acc,
        lastUsed: Math.max(existingAcc.lastUsed || 0, acc.lastUsed || 0),
        ...pickUsage(acc, existingAcc),
        usageUpdatedAt: Math.max(existingAcc.usageUpdatedAt || 0, acc.usageUpdatedAt || 0),
        rateLimitResetTime: Math.max(
          existingAcc.rateLimitResetTime || 0,
          acc.rateLimitResetTime || 0
        ),
        // Incoming is authoritative for isHealthy. OR-logic previously
        // (`existing.isHealthy || acc.isHealthy`) preserved a healthy DB
        // state when markUnhealthy set acc.isHealthy=false, leaving
        // in-memory and DB diverged.
        isHealthy: incomingRecovered ? true : hasPermanentError ? false : acc.isHealthy,
        unhealthyReason: incomingRecovered
          ? undefined
          : acc.unhealthyReason || existingAcc.unhealthyReason,
        recoveryTime: incomingRecovered ? undefined : acc.recoveryTime || existingAcc.recoveryTime,
        failCount: incomingRecovered
          ? acc.failCount || 0
          : Math.max(existingAcc.failCount || 0, acc.failCount || 0),
        lastSync: Math.max(existingAcc.lastSync || 0, acc.lastSync || 0)
      })
    } else {
      accountMap.set(acc.id, acc)
    }
  }

  return Array.from(accountMap.values())
}

/**
 * Resolve conflicting usage counters.
 *
 * The newest reading from the service wins, in either direction — quotas
 * reset, so "highest wins" ratchets the figure up forever. That guard only
 * applies when neither side was ever refreshed, where it stops an account
 * carrying no usage from zeroing a stored one.
 */
function pickUsage(
  incoming: ManagedAccount,
  existing: ManagedAccount
): { usedCount: number; limitCount: number } {
  const incomingAt = incoming.usageUpdatedAt || 0
  const existingAt = existing.usageUpdatedAt || 0

  if (incomingAt > 0 || existingAt > 0) {
    const fresher = incomingAt >= existingAt ? incoming : existing
    return { usedCount: fresher.usedCount || 0, limitCount: fresher.limitCount || 0 }
  }

  return {
    usedCount: Math.max(existing.usedCount || 0, incoming.usedCount || 0),
    limitCount: Math.max(existing.limitCount || 0, incoming.limitCount || 0)
  }
}

export function deduplicateAccounts(accounts: ManagedAccount[]): ManagedAccount[] {
  const accountMap = new Map<string, ManagedAccount>()

  for (const acc of accounts) {
    const existing = accountMap.get(acc.id)
    if (!existing) {
      accountMap.set(acc.id, acc)
      continue
    }

    const currLastUsed = acc.lastUsed || 0
    const existLastUsed = existing.lastUsed || 0

    if (currLastUsed > existLastUsed) {
      accountMap.set(acc.id, acc)
    } else if (currLastUsed === existLastUsed) {
      const currAddedAt = acc.expiresAt || 0
      const existAddedAt = existing.expiresAt || 0
      if (currAddedAt > existAddedAt) {
        accountMap.set(acc.id, acc)
      }
    }
  }

  return Array.from(accountMap.values())
}
