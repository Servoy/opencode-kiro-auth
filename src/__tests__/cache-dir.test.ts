import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getCacheDir, getConfigDir } from '../plugin/config/paths.js'
import { imageCache } from '../plugin/image-cache.js'

// Regenerable image data must live under the cache dir, never beside credentials
// and state in the config dir. These run against the real singleton and the real
// resolvers: if the cache is ever wired back to getConfigDir(), the persistence
// test stops finding its file under getCacheDir() and fails.
const imagesDir = join(getCacheDir(), 'kiro-images')

afterEach(() => {
  rmSync(imagesDir, { recursive: true, force: true })
})

describe('image cache location', () => {
  test('the cache dir is distinct from the state dir', () => {
    expect(getCacheDir()).not.toBe(getConfigDir())
  })

  test('the shared imageCache persists under getCacheDir()/kiro-images and nowhere else', () => {
    const configImages = join(getConfigDir(), 'kiro-images')
    rmSync(imagesDir, { recursive: true, force: true })
    rmSync(configImages, { recursive: true, force: true })

    imageCache.set('ws', 'fp', [{ format: 'png', source: { bytes: new Uint8Array([1, 2, 3, 4]) } }])

    try {
      // The file exists under the cache dir...
      expect(existsSync(imagesDir)).toBe(true)
      expect(readdirSync(imagesDir).some((f) => f.endsWith('.json'))).toBe(true)
      // ...and not under the config dir, which is the wiring the mutation broke.
      expect(existsSync(configImages)).toBe(false)
    } finally {
      imageCache.delete('ws', 'fp')
    }
  })
})
