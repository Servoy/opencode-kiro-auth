import { Model, Provider } from '@opencode/plugin'
import { describe, expect, test } from 'bun:test'
import { buildV2Provider } from '../v2/models-bridge.js'

describe('buildV2Provider', () => {
  test('says nothing about reasoning in capabilities, which cannot carry it', () => {
    // Model.Capabilities is exactly {tools, input, output} at 2.0.26. A key the
    // schema does not define never reaches the host, so the whole reasoning
    // story used to be dropped on the floor without a word.
    const { models } = buildV2Provider('kiro', 'https://x/v1', '')
    for (const m of models) {
      expect(Object.keys(m.capabilities).sort()).toEqual(['input', 'output', 'tools'])
    }
  })

  test('expresses reasoning as the compatibility the host actually reads', () => {
    // Kiro streams its thinking as `reasoning_content` (openai-converter.ts), so
    // that is the field name the host has to be told about.
    const { models } = buildV2Provider('kiro', 'https://x/v1', '')
    const thinking = models.find((m) => m.modelID === 'claude-opus-5-5')
    const plain = models.find((m) => m.modelID === 'claude-haiku-4-5')

    expect(thinking?.compatibility?.reasoningField).toBe('reasoning_content')
    // A model that cannot reason declares nothing, rather than declaring it wrongly.
    expect(plain?.compatibility?.reasoningField).toBeUndefined()
  })

  test('passes the real host constructor with reasoning declared', () => {
    const { models } = buildV2Provider('kiro', 'https://x/v1', '')
    const providerID = Provider.ID.make('kiro')
    for (const m of models) {
      const built = Model.Info.make({
        id: Model.ID.make(m.id),
        modelID: Model.ID.make(m.modelID),
        providerID,
        name: m.name,
        capabilities: m.capabilities,
        compatibility: m.compatibility,
        variants: [],
        time: m.time,
        cost: [],
        status: m.status,
        enabled: m.enabled,
        limit: m.limit
      } as never)
      expect(built.compatibility?.reasoningField).toBe(m.compatibility?.reasoningField)
    }
  })
  test('produces provider info with a package and baseURL', () => {
    const { info } = buildV2Provider('kiro', 'https://runtime.us-east-1.kiro.dev', '')
    expect(info.package).toContain('openai-compatible')
    expect((info.settings as { baseURL?: string }).baseURL).toContain('kiro.dev')
    expect(info.id).toBe('kiro')
    expect(info.name).toBe('Kiro')
  })

  test('emits one v2 model per registry entry with providerID and modelID stamped', () => {
    const { models } = buildV2Provider('kiro', 'https://x/v1', '')
    expect(models.length).toBeGreaterThan(0)
    for (const m of models) {
      expect(m.providerID).toBe('kiro')
      expect(typeof m.id).toBe('string')
      expect(m.modelID).toBe(m.id)
    }
  })

  test('every model satisfies the real @opencode/schema Model.Info shape', () => {
    // Validate against the actual host constructor, not a hand copy: a field
    // the v2 schema requires but the bridge omits (or one it rejects) throws
    // here, so a shape drift fails the test instead of only failing live.
    const providerID = Provider.ID.make('kiro')
    const { models } = buildV2Provider('kiro', 'https://x/v1', '')
    for (const m of models) {
      const built = Model.Info.make({
        id: Model.ID.make(m.id),
        modelID: Model.ID.make(m.modelID),
        providerID,
        name: m.name,
        capabilities: m.capabilities,
        variants: m.variants.map((v) => ({
          id: Model.VariantID.make(v.id),
          settings: v.settings
        })),
        time: m.time,
        cost: [],
        status: m.status,
        enabled: m.enabled,
        limit: m.limit
      })
      expect(built.providerID).toBe(providerID)
      expect(built.capabilities.tools).toBe(true)
    }
  })

  test('provider info satisfies the real Provider.Info shape', () => {
    const providerID = Provider.ID.make('kiro')
    const { info } = buildV2Provider('kiro', 'https://x/v1', '')
    const built = Provider.Info.make({
      id: providerID,
      name: info.name,
      activation: info.activation as never,
      package: info.package,
      settings: info.settings
    })
    expect(built.id).toBe(providerID)
  })

  test('reasoning models name the reasoning field and carry a variants array', () => {
    const { models } = buildV2Provider('kiro', 'https://x/v1', '')
    const sonnet = models.find((m) => m.id === 'claude-sonnet-4-5')
    expect(sonnet).toBeDefined()
    expect(sonnet!.compatibility?.reasoningField).toBe('reasoning_content')
    expect(Array.isArray(sonnet!.variants)).toBe(true)
    expect(sonnet!.variants.some((v) => v.id === 'high')).toBe(true)
  })

  test('non-reasoning models declare no reasoning field and carry no variants', () => {
    const { models } = buildV2Provider('kiro', 'https://x/v1', '')
    const qwen = models.find((m) => m.id === 'qwen3-coder-next')
    expect(qwen).toBeDefined()
    expect(qwen!.compatibility?.reasoningField).toBeUndefined()
    expect(qwen!.variants).toEqual([])
  })

  test('quota suffix is appended to model names when provided', () => {
    const { models } = buildV2Provider('kiro', 'https://x/v1', '· 42%')
    expect(models.some((m) => m.name.includes('· 42%'))).toBe(true)
  })

  test('carries the context and output limits from the registry', () => {
    const { models } = buildV2Provider('kiro', 'https://x/v1', '')
    const sonnet = models.find((m) => m.id === 'claude-sonnet-4-5')
    expect(sonnet?.limit.context).toBeGreaterThan(0)
    expect(sonnet?.limit.output).toBeGreaterThan(0)
  })
})
