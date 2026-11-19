import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// getConfigDir resolves once per process, so the override has to be in place
// before the loader is imported.
const dir = mkdtempSync(join(tmpdir(), 'kiro-region-'))
process.env.KIRO_CONFIG_DIR = dir
process.env.NODE_ENV = 'production'
delete process.env.KIRO_DEFAULT_REGION

const { loadConfig } = await import('../plugin/config/loader.js')
const { ServiceRegionSchema } = await import('../plugin/config/schema.js')
const { KIRO_SERVICE_REGIONS } = await import('../constants.js')

function withConfig(config: Record<string, unknown>) {
  writeFileSync(join(dir, 'kiro.json'), JSON.stringify(config, null, 2))
  return loadConfig(dir)
}

describe('default_region accepts only the regions Kiro serves', () => {
  test('keeps a region that is served', () => {
    expect(withConfig({ default_region: 'eu-central-1' }).default_region).toBe('eu-central-1')
  })

  test('substitutes a region that has no Kiro endpoint', () => {
    // management/runtime/q have no DNS record in eu-west-1, so this used to
    // fail as a name-resolution error with nothing pointing at the config.
    expect(withConfig({ default_region: 'eu-west-1' }).default_region).toBe('us-east-1')
  })

  test('substituting one value does not discard the rest of the file', () => {
    // The real risk of tightening this: a validation failure drops the whole
    // config, so a stale region would silently reset every other setting.
    const config = withConfig({
      default_region: 'ap-southeast-2',
      trace: true,
      max_request_iterations: 42,
      idc_start_url: 'https://d-996749b310.awsapps.com/start'
    })
    expect(config.default_region).toBe('us-east-1')
    expect(config.trace).toBe(true)
    expect(config.max_request_iterations).toBe(42)
    expect(config.idc_start_url).toBe('https://d-996749b310.awsapps.com/start')
  })

  test('idc_region still takes any AWS region', () => {
    // Identity Center is a different service and runs where the organisation
    // put it; only the Kiro endpoints are limited to two regions.
    const config = withConfig({ idc_region: 'eu-west-1', default_region: 'eu-central-1' })
    expect(config.idc_region).toBe('eu-west-1')
    expect(config.default_region).toBe('eu-central-1')
  })
})

describe('the served-region list', () => {
  test('is one list, not two that can drift', () => {
    expect([...KIRO_SERVICE_REGIONS]).toEqual([...ServiceRegionSchema.options])
  })

  test('names exactly the regions that answer', () => {
    // Verified against DNS: management/runtime/q resolve in these two and
    // nowhere else in the commercial partition.
    expect([...ServiceRegionSchema.options].sort()).toEqual(['eu-central-1', 'us-east-1'])
  })
})
