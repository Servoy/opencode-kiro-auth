import { describe, expect, test } from 'bun:test'
import { AccountCache } from '../infrastructure/database/account-cache.js'

// The real AccountCache. AccountRepository leans on it for every read, so its
// TTL, per-id and all-accounts paths, and the invalidation routes all matter.

const acc = (id: string) => ({ id, email: `${id}@x` })

describe('AccountCache', () => {
  test('returns null before anything is stored', () => {
    const cache = new AccountCache()
    expect(cache.getAll()).toBeNull()
    expect(cache.get('a')).toBeNull()
  })

  test('setAll fills both the per-id and all-accounts views', () => {
    const cache = new AccountCache()
    cache.setAll([acc('a'), acc('b')])

    expect(cache.getAll()).toEqual([acc('a'), acc('b')])
    expect(cache.get('a')).toEqual(acc('a'))
    expect(cache.get('b')).toEqual(acc('b'))
  })

  test('getAll hands back a copy, so mutating the result cannot corrupt the cache', () => {
    const cache = new AccountCache()
    cache.setAll([acc('a')])
    const first = cache.getAll()!
    first.push(acc('x'))
    expect(cache.getAll()).toHaveLength(1)
  })

  test('set adds a single entry reachable by id', () => {
    const cache = new AccountCache()
    cache.set('a', acc('a'))
    expect(cache.get('a')).toEqual(acc('a'))
  })

  test('invalidate drops the one id and the all-accounts view, keeping others', () => {
    const cache = new AccountCache()
    cache.setAll([acc('a'), acc('b')])
    cache.invalidate('a')

    expect(cache.get('a')).toBeNull()
    expect(cache.getAll()).toBeNull() // all-accounts view dropped
    expect(cache.get('b')).toEqual(acc('b')) // untouched id still cached
  })

  test('invalidateAll clears every entry and the TTL clock', () => {
    const cache = new AccountCache()
    cache.setAll([acc('a'), acc('b')])
    cache.invalidateAll()

    expect(cache.get('a')).toBeNull()
    expect(cache.get('b')).toBeNull()
    expect(cache.getAll()).toBeNull()
  })

  test('expires every read once the TTL has passed', async () => {
    const cache = new AccountCache(5) // 5ms TTL
    cache.setAll([acc('a')])
    expect(cache.getAll()).not.toBeNull()

    await new Promise((r) => setTimeout(r, 15))

    expect(cache.getAll()).toBeNull()
    expect(cache.get('a')).toBeNull()
  })
})
