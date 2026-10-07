import { describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const debugLines: string[] = []

mock.module('../plugin/logger.js', () => ({
  debug: (message: string) => {
    debugLines.push(message)
  },
  error: () => {},
  log: () => {},
  warn: () => {},
  setDebugEnabled: () => {},
  getTimestamp: () => '2026-10-07T00:00:00.000Z',
  logApiError: () => {},
  logApiRequest: () => {},
  logApiResponse: () => {}
}))

const { withDatabaseLock } = await import('../plugin/storage/locked-operations.js')

function tmpDbPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kiro-lock-test-'))
  return { dir, path: join(dir, 'test.db') }
}

describe('withDatabaseLock in-process serialisation', () => {
  test('runs writes one at a time even when started concurrently', async () => {
    const { dir, path } = tmpDbPath()
    try {
      const observed: string[] = []
      let active = 0

      const makeWrite = (name: string) => () =>
        withDatabaseLock(path, async () => {
          active++
          // If two writes ran at once this would exceed 1 — the whole point of
          // the in-process chain is that it never does.
          expect(active).toBe(1)
          observed.push(name)
          await new Promise((r) => setTimeout(r, 10))
          active--
        })

      await Promise.all([makeWrite('a')(), makeWrite('b')(), makeWrite('c')()])
      expect(observed).toEqual(['a', 'b', 'c'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('logs the lane a slow write waited in, with how many were ahead', async () => {
    const { dir, path } = tmpDbPath()
    debugLines.length = 0
    try {
      // First write holds the chain long enough that the second must wait, so
      // the second logs chainWait with ahead>0 — the "waited on another" signal.
      const slow = withDatabaseLock(
        path,
        async () => {
          await new Promise((r) => setTimeout(r, 80))
        },
        'slow-write'
      )
      // Give the first write a tick to take the chain before the second queues.
      await new Promise((r) => setTimeout(r, 5))
      const second = withDatabaseLock(path, async () => {}, 'second-write')

      await Promise.all([slow, second])

      const line = debugLines.find((l) => l.includes('[LOCK] second-write'))
      expect(line).toBeDefined()
      expect(line).toContain('ahead=1')
      // The label is named, not guessed at.
      expect(line).toContain('second-write')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
