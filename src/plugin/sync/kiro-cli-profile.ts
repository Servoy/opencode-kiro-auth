import { existsSync } from 'node:fs'
import { openDatabase, type SqliteDatabase } from '../storage/database-driver'
import { getCliDbPath, safeJsonParse } from './kiro-cli-parser'

export function readActiveProfileArnFromKiroCli(): string | undefined {
  const dbPath = getCliDbPath()
  if (!existsSync(dbPath)) return undefined

  let cliDb: SqliteDatabase | undefined
  try {
    cliDb = openDatabase(dbPath, { readonly: true })
    cliDb.exec('PRAGMA busy_timeout = 5000')

    const row = cliDb
      .prepare('SELECT value FROM state WHERE key = ?')
      .get('api.codewhisperer.profile') as any
    const parsed = safeJsonParse(row?.value)
    const arn = parsed?.arn || parsed?.profileArn || parsed?.profile_arn
    return typeof arn === 'string' && arn.trim() ? arn.trim() : undefined
  } catch {
    return undefined
  } finally {
    try {
      cliDb?.close()
    } catch {
      // ignore
    }
  }
}
