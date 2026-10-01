import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Drive the real logger end to end. getConfigDir resolves and caches once per
// run (and ignores KIRO_CONFIG_DIR under NODE_ENV=test), so the log dir is
// whatever getLogDir reports — read it, don't assume it. Each test clears the
// files it touches so the shared dir stays clean across the suite.
let logger: typeof import('../plugin/logger.js')
let dir: string

beforeEach(async () => {
  logger = await import('../plugin/logger.js')
  dir = logger.getLogDir()
  mkdirSync(dir, { recursive: true })
  resetLogFiles()
})

afterEach(() => {
  resetLogFiles()
})

function resetLogFiles() {
  for (const f of [
    join(dir, 'kiro-plugin.log'),
    join(dir, 'kiro-plugin.log.1'),
    join(dir, 'plugin.log')
  ]) {
    try {
      rmSync(f, { force: true })
    } catch {}
  }
  try {
    rmSync(join(dir, 'kiro-log'), { recursive: true, force: true })
  } catch {}
}

describe('plugin log file', () => {
  test('writes to kiro-plugin.log, not the generic plugin.log', () => {
    expect(logger.getLogPath()).toBe(join(dir, 'kiro-plugin.log'))
    expect(logger.getLogPath().endsWith('kiro-plugin.log')).toBe(true)
  })

  test('rotates to kiro-plugin.log.1 once the file exceeds the size cap', () => {
    const path = join(dir, 'kiro-plugin.log')
    // Seed a file already over the cap so the next write triggers rotation.
    writeFileSync(path, 'x'.repeat(logger.LOG_MAX_BYTES + 1))

    logger.error('a line after the cap was exceeded')

    expect(existsSync(join(dir, 'kiro-plugin.log.1'))).toBe(true)
    // The live file restarted small — it holds the new line, not the old bulk.
    expect(statSync(path).size).toBeLessThan(logger.LOG_MAX_BYTES)
  })

  test('keeps only one rotated generation (a second rotation overwrites .1)', () => {
    const path = join(dir, 'kiro-plugin.log')

    writeFileSync(path, 'x'.repeat(logger.LOG_MAX_BYTES + 1))
    logger.error('first rotation')
    writeFileSync(path, 'y'.repeat(logger.LOG_MAX_BYTES + 1))
    logger.error('second rotation')

    const rotated = readdirSync(dir).filter((f) => /^kiro-plugin\.log\.\d+$/.test(f))
    expect(rotated).toEqual(['kiro-plugin.log.1'])
  })

  test('migrates an existing plugin.log to the new name on first write', () => {
    const legacy = join(dir, 'plugin.log')
    writeFileSync(legacy, 'old history line\n')

    logger.error('new line')

    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(join(dir, 'kiro-plugin.log'))).toBe(true)
  })
})

describe('api dump cleanup', () => {
  test('deletes dumps older than the retention window, keeps recent ones', async () => {
    const apiDir = logger.getApiLogDir()
    mkdirSync(apiDir, { recursive: true })

    const old = join(apiDir, 'old_request.json')
    const recent = join(apiDir, 'recent_request.json')
    writeFileSync(old, '{}')
    writeFileSync(recent, '{}')
    // Backdate the old file past the retention window.
    const past = Date.now() - (logger.API_LOG_TTL_MS + 60_000)
    const { utimesSync } = await import('node:fs')
    utimesSync(old, new Date(past), new Date(past))

    logger.cleanupApiLogs()

    expect(existsSync(old)).toBe(false)
    expect(existsSync(recent)).toBe(true)
  })
})
