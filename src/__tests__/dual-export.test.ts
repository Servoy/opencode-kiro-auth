import { describe, expect, test } from 'bun:test'
import plugin from '../index.js'

describe('dual export', () => {
  test('default export exposes a v2 id and setup', () => {
    expect((plugin as { id: string }).id).toBe('kiro')
    expect(typeof (plugin as { setup: unknown }).setup).toBe('function')
  })

  test('default export exposes a v1 server function', () => {
    expect(typeof (plugin as { server: unknown }).server).toBe('function')
  })
})
