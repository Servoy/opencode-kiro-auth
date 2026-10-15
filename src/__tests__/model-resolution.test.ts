import { describe, expect, test } from 'bun:test'
import { SUPPORTED_MODELS } from '../constants.js'
import { resolveKiroModel } from '../plugin/models.js'

describe('resolveKiroModel', () => {
  test('resolves newly advertised model slugs', () => {
    expect(resolveKiroModel('auto')).toBe('auto')
    expect(resolveKiroModel('minimax-m2.5')).toBe('minimax-m2.5')
    expect(resolveKiroModel('minimax-m2.1')).toBe('minimax-m2.1')
    expect(resolveKiroModel('qwen3-coder-next')).toBe('qwen3-coder-next')
    expect(resolveKiroModel('kimi-k3')).toBe('kimi-k3')
  })

  test('resolves the -1m slugs a saved config may still name, to a model Kiro serves', () => {
    // These were never advertised — the only way to reach one is an explicit
    // opencode.json entry — so removing them outright would break a config that
    // used to resolve. They named models Kiro does not serve, so the slug now
    // resolves to the base model, whose window is the 1M one anyway.
    for (const [slug, base] of [
      ['claude-sonnet-4-6-1m', 'claude-sonnet-4.6'],
      ['claude-sonnet-4-6-1m-thinking', 'claude-sonnet-4.6'],
      ['claude-sonnet-5-1m', 'claude-sonnet-5'],
      ['claude-sonnet-5-1m-thinking', 'claude-sonnet-5'],
      ['claude-sonnet-5-5-1m', 'claude-sonnet-5.5'],
      ['claude-sonnet-5-5-1m-thinking', 'claude-sonnet-5.5'],
      ['claude-opus-4-6-1m', 'claude-opus-4.6'],
      ['claude-opus-4-6-1m-thinking', 'claude-opus-4.6']
    ] as Array<[string, string]>) {
      expect(resolveKiroModel(slug)).toBe(base)
    }
  })

  test('resolves the -1m slugs whose base model is 200K, rather than failing', () => {
    // Sonnet 4.5 never gained a 1M window. The old slug asked for one Kiro does
    // not have; resolving it to the model that exists is still better than the
    // "Invalid model ID" it used to earn.
    expect(resolveKiroModel('claude-sonnet-4-5-1m')).toBe('claude-sonnet-4.5')
    expect(resolveKiroModel('claude-sonnet-4-5-1m-thinking')).toBe('claude-sonnet-4.5')
  })

  test('resolves the open-weight models Kiro documents, catalog or not', () => {
    // DeepSeek 3.2 and GLM-5 are on kiro.dev for every tier in US and EU. An
    // API-key account's catalog omits both, and that account gets "Invalid model
    // ID" for them — but the catalog is per-account, so dropping them from the
    // mapping would hide them from every account that does have them.
    expect(resolveKiroModel('deepseek-3.2')).toBe('deepseek-3.2')
    expect(resolveKiroModel('glm-5')).toBe('glm-5')
  })

  test('keeps existing supported Claude slugs intact', () => {
    expect(resolveKiroModel('claude-sonnet-4-5')).toBe('claude-sonnet-4.5')
    expect(resolveKiroModel('claude-sonnet-4')).toBe('claude-sonnet-4')
    expect(resolveKiroModel('claude-opus-4-8')).toBe('claude-opus-4.8')
    expect(resolveKiroModel('claude-opus-4-8-thinking')).toBe('claude-opus-4.8')
  })

  test('resolves claude-sonnet-5 slugs', () => {
    expect(resolveKiroModel('claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(resolveKiroModel('claude-sonnet-5-thinking')).toBe('claude-sonnet-5')
  })

  test('resolves claude-sonnet-5-5 slugs', () => {
    expect(resolveKiroModel('claude-sonnet-5-5')).toBe('claude-sonnet-5.5')
    expect(resolveKiroModel('claude-sonnet-5-5-thinking')).toBe('claude-sonnet-5.5')
  })

  test('rejects removed qwen3-coder-480b slug', () => {
    expect(() => resolveKiroModel('qwen3-coder-480b')).toThrow(
      'Unsupported model: qwen3-coder-480b'
    )
  })

  test('supported model list excludes removed qwen3-coder-480b slug', () => {
    expect(SUPPORTED_MODELS).not.toContain('qwen3-coder-480b')
  })

  test('rejects unknown slugs', () => {
    expect(() => resolveKiroModel('this-model-does-not-exist')).toThrow(
      'Unsupported model: this-model-does-not-exist'
    )
  })
})
