import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { getUserConfigPath } from '../plugin/config/loader.js'
import { getConfigDir } from '../plugin/config/paths.js'
import { getLogDir } from '../plugin/logger.js'

// The bug this locks out: plugin.log resolving somewhere other than the config,
// so it lands where nobody looks. Assert the wiring against the real
// resolvers — getLogDir is the exact function the logger writes through, so a
// regression that split the log off from kiro.json fails here.
describe('the log and the config share one directory', () => {
  test('getLogDir is the config dir', () => {
    expect(getLogDir()).toBe(getConfigDir())
  })

  test('kiro.json resolves inside that same dir', () => {
    expect(getUserConfigPath()).toBe(join(getLogDir(), 'kiro.json'))
  })
})
