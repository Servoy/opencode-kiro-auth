import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getEffectiveEffort } from '../plugin/effort.js'
import { buildModelRegistry } from '../plugin/model-registry.js'
import { buildModelRequestFields } from '../plugin/model-request-fields.js'
import { refreshModelCatalog, resetModelCatalog, resolveKiroModel } from '../plugin/models.js'

/**
 * Characterization of the request fields and variants shipped in 2.7.0.
 *
 * Written before the catalog-driven refactor and kept as the compatibility
 * lock: the tables were produced by the old code and must not move except
 * where a test below says they may.
 */
const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures', 'kiro-catalog.json'), 'utf8')
)

const AUTH = { access: 'a', refresh: 'r', expires: 0, authMethod: 'idc', region: 'us-east-1' }

function blockFor(
  kiroModel: string,
  effort: string | undefined,
  off: boolean,
  maxTokens: number | undefined
) {
  const effective = off ? undefined : getEffectiveEffort(kiroModel, !!effort, effort as any)
  return buildModelRequestFields(kiroModel, effective, off, maxTokens)
}

async function withCatalog(run: () => void): Promise<void> {
  resetModelCatalog()
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(FIXTURE), { status: 200 })) as unknown as typeof fetch
  try {
    await refreshModelCatalog(AUTH as any)
    run()
  } finally {
    globalThis.fetch = original
    resetModelCatalog()
  }
}

function assertVariants(expected: Record<string, string[]>): void {
  const registry = buildModelRegistry() as Record<string, any>
  expect(Object.keys(registry).sort()).toEqual(Object.keys(expected).sort())
  for (const [id, levels] of Object.entries(expected)) {
    expect({ id, levels: Object.keys(registry[id]?.variants ?? {}) }).toEqual({ id, levels })
  }
}

function assertBlocks(expected: Record<string, string | undefined>): void {
  for (const [key, want] of Object.entries(expected)) {
    const [id, effort, off, max] = key.split('|')
    const value = blockFor(
      resolveKiroModel(id!),
      effort === 'default' ? undefined : effort,
      off === 'off',
      max === 'none' ? undefined : Number(max)
    )
    if (want === undefined) {
      expect({ key, block: value }).toEqual({ key, block: undefined })
    } else {
      expect({ key, block: JSON.stringify(value) }).toEqual({ key, block: want })
    }
  }
}

beforeEach(() => {
  resetModelCatalog()
})

afterEach(() => {
  resetModelCatalog()
})

const EXPECTED_VARIANTS_NOCATALOG: Record<string, string[]> = {
  auto: [],
  'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-4': [],
  'claude-sonnet-4-5': ['low', 'medium', 'high', 'max'],
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'max'],
  'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-haiku-4-5': [],
  'claude-opus-4-5': ['low', 'medium', 'high', 'max'],
  'claude-opus-4-6': ['low', 'medium', 'high', 'max'],
  'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'deepseek-3.2': [],
  'glm-5': [],
  'minimax-m2.5': [],
  'minimax-m2.1': [],
  'qwen3-coder-next': []
}

const EXPECTED_BLOCKS_NOCATALOG: Record<string, string | undefined> = {
  'auto|default|on|none': undefined,
  'auto|low|on|none': undefined,
  'auto|max|on|none': undefined,
  'auto|xhigh|on|4096': '{"max_tokens":4096}',
  'auto|default|off|4096': '{"max_tokens":4096}',
  'gpt-5.6-sol|default|on|none': undefined,
  'gpt-5.6-sol|low|on|none': '{"reasoning":{"effort":"low"}}',
  'gpt-5.6-sol|max|on|none': '{"reasoning":{"effort":"max"}}',
  'gpt-5.6-sol|xhigh|on|4096': '{"reasoning":{"effort":"xhigh"},"max_tokens":4096}',
  'gpt-5.6-sol|default|off|4096': '{"reasoning":{"effort":"none"},"max_tokens":4096}',
  'gpt-5.6-terra|default|on|none': undefined,
  'gpt-5.6-terra|low|on|none': '{"reasoning":{"effort":"low"}}',
  'gpt-5.6-terra|max|on|none': '{"reasoning":{"effort":"max"}}',
  'gpt-5.6-terra|xhigh|on|4096': '{"reasoning":{"effort":"xhigh"},"max_tokens":4096}',
  'gpt-5.6-terra|default|off|4096': '{"reasoning":{"effort":"none"},"max_tokens":4096}',
  'gpt-5.6-luna|default|on|none': undefined,
  'gpt-5.6-luna|low|on|none': '{"reasoning":{"effort":"low"}}',
  'gpt-5.6-luna|max|on|none': '{"reasoning":{"effort":"max"}}',
  'gpt-5.6-luna|xhigh|on|4096': '{"reasoning":{"effort":"xhigh"},"max_tokens":4096}',
  'gpt-5.6-luna|default|off|4096': '{"reasoning":{"effort":"none"},"max_tokens":4096}',
  'claude-sonnet-4|default|on|none': undefined,
  'claude-sonnet-4|low|on|none': undefined,
  'claude-sonnet-4|max|on|none': undefined,
  'claude-sonnet-4|xhigh|on|4096': '{"max_tokens":4096}',
  'claude-sonnet-4|default|off|4096': '{"max_tokens":4096}',
  'claude-sonnet-4-5|default|on|none': undefined,
  'claude-sonnet-4-5|low|on|none': '{"output_config":{"effort":"low"}}',
  'claude-sonnet-4-5|max|on|none': '{"output_config":{"effort":"max"}}',
  'claude-sonnet-4-5|xhigh|on|4096': '{"output_config":{"effort":"max"},"max_tokens":4096}',
  'claude-sonnet-4-5|default|off|4096': '{"max_tokens":4096}',
  'claude-sonnet-4-6|default|on|none': undefined,
  'claude-sonnet-4-6|low|on|none': '{"output_config":{"effort":"low"}}',
  'claude-sonnet-4-6|max|on|none': '{"output_config":{"effort":"max"}}',
  'claude-sonnet-4-6|xhigh|on|4096': '{"output_config":{"effort":"max"},"max_tokens":4096}',
  'claude-sonnet-4-6|default|off|4096': '{"max_tokens":4096}',
  'claude-sonnet-5|default|on|none': undefined,
  'claude-sonnet-5|low|on|none': '{"output_config":{"effort":"low"}}',
  'claude-sonnet-5|max|on|none': '{"output_config":{"effort":"max"}}',
  'claude-sonnet-5|xhigh|on|4096': '{"output_config":{"effort":"xhigh"},"max_tokens":4096}',
  'claude-sonnet-5|default|off|4096': '{"max_tokens":4096}',
  'claude-sonnet-5-5|default|on|none': undefined,
  'claude-sonnet-5-5|low|on|none': '{"output_config":{"effort":"low"}}',
  'claude-sonnet-5-5|max|on|none': '{"output_config":{"effort":"max"}}',
  'claude-sonnet-5-5|xhigh|on|4096': '{"output_config":{"effort":"xhigh"},"max_tokens":4096}',
  'claude-sonnet-5-5|default|off|4096': '{"max_tokens":4096}',
  'claude-haiku-4-5|default|on|none': undefined,
  'claude-haiku-4-5|low|on|none': undefined,
  'claude-haiku-4-5|max|on|none': undefined,
  'claude-haiku-4-5|xhigh|on|4096': '{"max_tokens":4096}',
  'claude-haiku-4-5|default|off|4096': '{"max_tokens":4096}',
  'claude-opus-4-5|default|on|none': undefined,
  'claude-opus-4-5|low|on|none': '{"output_config":{"effort":"low"}}',
  'claude-opus-4-5|max|on|none': '{"output_config":{"effort":"max"}}',
  'claude-opus-4-5|xhigh|on|4096': '{"output_config":{"effort":"max"},"max_tokens":4096}',
  'claude-opus-4-5|default|off|4096': '{"max_tokens":4096}',
  'claude-opus-4-6|default|on|none': undefined,
  'claude-opus-4-6|low|on|none': '{"output_config":{"effort":"low"}}',
  'claude-opus-4-6|max|on|none': '{"output_config":{"effort":"max"}}',
  'claude-opus-4-6|xhigh|on|4096': '{"output_config":{"effort":"max"},"max_tokens":4096}',
  'claude-opus-4-6|default|off|4096': '{"max_tokens":4096}',
  'claude-opus-4-7|default|on|none': undefined,
  'claude-opus-4-7|low|on|none': '{"output_config":{"effort":"low"}}',
  'claude-opus-4-7|max|on|none': '{"output_config":{"effort":"max"}}',
  'claude-opus-4-7|xhigh|on|4096': '{"output_config":{"effort":"xhigh"},"max_tokens":4096}',
  'claude-opus-4-7|default|off|4096': '{"max_tokens":4096}',
  'claude-opus-4-8|default|on|none': undefined,
  'claude-opus-4-8|low|on|none': '{"output_config":{"effort":"low"}}',
  'claude-opus-4-8|max|on|none': '{"output_config":{"effort":"max"}}',
  'claude-opus-4-8|xhigh|on|4096': '{"output_config":{"effort":"xhigh"},"max_tokens":4096}',
  'claude-opus-4-8|default|off|4096': '{"max_tokens":4096}',
  'claude-opus-5|default|on|none': undefined,
  'claude-opus-5|low|on|none': '{"output_config":{"effort":"low"}}',
  'claude-opus-5|max|on|none': '{"output_config":{"effort":"max"}}',
  'claude-opus-5|xhigh|on|4096': '{"output_config":{"effort":"xhigh"},"max_tokens":4096}',
  'claude-opus-5|default|off|4096': '{"max_tokens":4096}',
  'claude-opus-5-5|default|on|none': undefined,
  'claude-opus-5-5|low|on|none': '{"output_config":{"effort":"low"}}',
  'claude-opus-5-5|max|on|none': '{"output_config":{"effort":"max"}}',
  'claude-opus-5-5|xhigh|on|4096': '{"output_config":{"effort":"xhigh"},"max_tokens":4096}',
  'claude-opus-5-5|default|off|4096': '{"max_tokens":4096}',
  'deepseek-3.2|default|on|none': undefined,
  'deepseek-3.2|low|on|none': undefined,
  'deepseek-3.2|max|on|none': undefined,
  'deepseek-3.2|xhigh|on|4096': '{"max_tokens":4096}',
  'deepseek-3.2|default|off|4096': '{"max_tokens":4096}',
  'glm-5|default|on|none': undefined,
  'glm-5|low|on|none': undefined,
  'glm-5|max|on|none': undefined,
  'glm-5|xhigh|on|4096': '{"max_tokens":4096}',
  'glm-5|default|off|4096': '{"max_tokens":4096}',
  'minimax-m2.5|default|on|none': undefined,
  'minimax-m2.5|low|on|none': undefined,
  'minimax-m2.5|max|on|none': undefined,
  'minimax-m2.5|xhigh|on|4096': '{"max_tokens":4096}',
  'minimax-m2.5|default|off|4096': '{"max_tokens":4096}',
  'minimax-m2.1|default|on|none': undefined,
  'minimax-m2.1|low|on|none': undefined,
  'minimax-m2.1|max|on|none': undefined,
  'minimax-m2.1|xhigh|on|4096': '{"max_tokens":4096}',
  'minimax-m2.1|default|off|4096': '{"max_tokens":4096}',
  'qwen3-coder-next|default|on|none': undefined,
  'qwen3-coder-next|low|on|none': undefined,
  'qwen3-coder-next|max|on|none': undefined,
  'qwen3-coder-next|xhigh|on|4096': '{"max_tokens":4096}',
  'qwen3-coder-next|default|off|4096': '{"max_tokens":4096}'
}

const EXPECTED_VARIANTS_WITHCATALOG: Record<string, string[]> = {
  auto: [],
  'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-4': [],
  'claude-sonnet-4-5': ['low', 'medium', 'high', 'max'],
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'max'],
  'claude-sonnet-5': ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-haiku-4-5': [],
  'claude-opus-4-5': ['low', 'medium', 'high', 'max'],
  'claude-opus-4-6': ['low', 'medium', 'high', 'max'],
  'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-5': ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'deepseek-3.2': [],
  'glm-5': [],
  'minimax-m2.5': [],
  'minimax-m2.1': [],
  'qwen3-coder-next': []
}

const EXPECTED_BLOCKS_WITHCATALOG: Record<string, string | undefined> = {
  'auto|default|on|none': undefined,
  'auto|low|on|none': undefined,
  'auto|max|on|none': undefined,
  'auto|xhigh|on|4096': '{"max_tokens":4096}',
  'auto|default|off|4096': '{"max_tokens":4096}',
  'gpt-5.6-sol|default|on|none': undefined,
  'gpt-5.6-sol|low|on|none': '{"reasoning":{"effort":"low"}}',
  'gpt-5.6-sol|max|on|none': '{"reasoning":{"effort":"max"}}',
  'gpt-5.6-sol|xhigh|on|4096': '{"reasoning":{"effort":"xhigh"},"max_tokens":4096}',
  'gpt-5.6-sol|default|off|4096': '{"reasoning":{"effort":"none"},"max_tokens":4096}',
  'gpt-5.6-terra|default|on|none': undefined,
  'gpt-5.6-terra|low|on|none': '{"reasoning":{"effort":"low"}}',
  'gpt-5.6-terra|max|on|none': '{"reasoning":{"effort":"max"}}',
  'gpt-5.6-terra|xhigh|on|4096': '{"reasoning":{"effort":"xhigh"},"max_tokens":4096}',
  'gpt-5.6-terra|default|off|4096': '{"reasoning":{"effort":"none"},"max_tokens":4096}',
  'gpt-5.6-luna|default|on|none': undefined,
  'gpt-5.6-luna|low|on|none': '{"reasoning":{"effort":"low"}}',
  'gpt-5.6-luna|max|on|none': '{"reasoning":{"effort":"max"}}',
  'gpt-5.6-luna|xhigh|on|4096': '{"reasoning":{"effort":"xhigh"}}',
  'gpt-5.6-luna|default|off|4096': '{"reasoning":{"effort":"none"}}',
  'claude-sonnet-4|default|on|none': undefined,
  'claude-sonnet-4|low|on|none': undefined,
  'claude-sonnet-4|max|on|none': undefined,
  'claude-sonnet-4|xhigh|on|4096': '{"max_tokens":4096}',
  'claude-sonnet-4|default|off|4096': '{"max_tokens":4096}',
  'claude-sonnet-4-5|default|on|none': undefined,
  'claude-sonnet-4-5|low|on|none': '{"output_config":{"effort":"low"}}',
  'claude-sonnet-4-5|max|on|none': '{"output_config":{"effort":"max"}}',
  'claude-sonnet-4-5|xhigh|on|4096': '{"output_config":{"effort":"max"},"max_tokens":4096}',
  'claude-sonnet-4-5|default|off|4096': '{"max_tokens":4096}',
  'claude-sonnet-4-6|default|on|none': undefined,
  'claude-sonnet-4-6|low|on|none': '{"output_config":{"effort":"low"}}',
  'claude-sonnet-4-6|max|on|none': '{"output_config":{"effort":"max"}}',
  'claude-sonnet-4-6|xhigh|on|4096': '{"output_config":{"effort":"max"},"max_tokens":4096}',
  'claude-sonnet-4-6|default|off|4096': '{"max_tokens":4096}',
  'claude-sonnet-5|default|on|none': undefined,
  'claude-sonnet-5|low|on|none': '{"output_config":{"effort":"low"}}',
  'claude-sonnet-5|max|on|none': '{"output_config":{"effort":"max"}}',
  'claude-sonnet-5|xhigh|on|4096': '{"output_config":{"effort":"xhigh"},"max_tokens":4096}',
  'claude-sonnet-5|default|off|4096':
    '{"thinking":{"type":"disabled"},"output_config":{"effort":"high"},"max_tokens":4096}',
  'claude-sonnet-5-5|default|on|none': undefined,
  'claude-sonnet-5-5|low|on|none': '{"output_config":{"effort":"low"}}',
  'claude-sonnet-5-5|max|on|none': '{"output_config":{"effort":"max"}}',
  'claude-sonnet-5-5|xhigh|on|4096': '{"output_config":{"effort":"xhigh"},"max_tokens":4096}',
  'claude-sonnet-5-5|default|off|4096': '{"max_tokens":4096}',
  'claude-haiku-4-5|default|on|none': undefined,
  'claude-haiku-4-5|low|on|none': undefined,
  'claude-haiku-4-5|max|on|none': undefined,
  'claude-haiku-4-5|xhigh|on|4096': undefined,
  'claude-haiku-4-5|default|off|4096': undefined,
  'claude-opus-4-5|default|on|none': undefined,
  'claude-opus-4-5|low|on|none': '{"output_config":{"effort":"low"}}',
  'claude-opus-4-5|max|on|none': '{"output_config":{"effort":"max"}}',
  'claude-opus-4-5|xhigh|on|4096': '{"output_config":{"effort":"max"},"max_tokens":4096}',
  'claude-opus-4-5|default|off|4096': '{"max_tokens":4096}',
  'claude-opus-4-6|default|on|none': undefined,
  'claude-opus-4-6|low|on|none': '{"output_config":{"effort":"low"}}',
  'claude-opus-4-6|max|on|none': '{"output_config":{"effort":"max"}}',
  'claude-opus-4-6|xhigh|on|4096': '{"output_config":{"effort":"max"},"max_tokens":4096}',
  'claude-opus-4-6|default|off|4096': '{"max_tokens":4096}',
  'claude-opus-4-7|default|on|none': undefined,
  'claude-opus-4-7|low|on|none': '{"output_config":{"effort":"low"}}',
  'claude-opus-4-7|max|on|none': '{"output_config":{"effort":"max"}}',
  'claude-opus-4-7|xhigh|on|4096': '{"output_config":{"effort":"xhigh"},"max_tokens":4096}',
  'claude-opus-4-7|default|off|4096': '{"max_tokens":4096}',
  'claude-opus-4-8|default|on|none': undefined,
  'claude-opus-4-8|low|on|none': '{"output_config":{"effort":"low"}}',
  'claude-opus-4-8|max|on|none': '{"output_config":{"effort":"max"}}',
  'claude-opus-4-8|xhigh|on|4096': '{"output_config":{"effort":"xhigh"},"max_tokens":4096}',
  'claude-opus-4-8|default|off|4096': '{"max_tokens":4096}',
  'claude-opus-5|default|on|none': undefined,
  'claude-opus-5|low|on|none': '{"output_config":{"effort":"low"}}',
  'claude-opus-5|max|on|none': '{"output_config":{"effort":"max"}}',
  'claude-opus-5|xhigh|on|4096': '{"output_config":{"effort":"xhigh"},"max_tokens":4096}',
  'claude-opus-5|default|off|4096':
    '{"thinking":{"type":"disabled"},"output_config":{"effort":"high"},"max_tokens":4096}',
  'claude-opus-5-5|default|on|none': undefined,
  'claude-opus-5-5|low|on|none': '{"output_config":{"effort":"low"}}',
  'claude-opus-5-5|max|on|none': '{"output_config":{"effort":"max"}}',
  'claude-opus-5-5|xhigh|on|4096': '{"output_config":{"effort":"xhigh"},"max_tokens":4096}',
  'claude-opus-5-5|default|off|4096': '{"max_tokens":4096}',
  'deepseek-3.2|default|on|none': undefined,
  'deepseek-3.2|low|on|none': undefined,
  'deepseek-3.2|max|on|none': undefined,
  'deepseek-3.2|xhigh|on|4096': '{"max_tokens":4096}',
  'deepseek-3.2|default|off|4096': '{"max_tokens":4096}',
  'glm-5|default|on|none': undefined,
  'glm-5|low|on|none': undefined,
  'glm-5|max|on|none': undefined,
  'glm-5|xhigh|on|4096': '{"max_tokens":4096}',
  'glm-5|default|off|4096': '{"max_tokens":4096}',
  'minimax-m2.5|default|on|none': undefined,
  'minimax-m2.5|low|on|none': undefined,
  'minimax-m2.5|max|on|none': undefined,
  'minimax-m2.5|xhigh|on|4096': '{"max_tokens":4096}',
  'minimax-m2.5|default|off|4096': '{"max_tokens":4096}',
  'minimax-m2.1|default|on|none': undefined,
  'minimax-m2.1|low|on|none': undefined,
  'minimax-m2.1|max|on|none': undefined,
  'minimax-m2.1|xhigh|on|4096': '{"max_tokens":4096}',
  'minimax-m2.1|default|off|4096': '{"max_tokens":4096}',
  'qwen3-coder-next|default|on|none': undefined,
  'qwen3-coder-next|low|on|none': undefined,
  'qwen3-coder-next|max|on|none': undefined,
  'qwen3-coder-next|xhigh|on|4096': '{"max_tokens":4096}',
  'qwen3-coder-next|default|off|4096': '{"max_tokens":4096}'
}

describe('request fields today, no catalog', () => {
  test('every registry model keeps its variants', () => {
    assertVariants(EXPECTED_VARIANTS_NOCATALOG)
  })

  test('every registry model gets the block it got before the refactor', () => {
    assertBlocks(EXPECTED_BLOCKS_NOCATALOG)
  })
})

describe('request fields today, with the account catalog', () => {
  test('variants follow the catalog schema and nothing else', async () => {
    await withCatalog(() => assertVariants(EXPECTED_VARIANTS_WITHCATALOG))
  })

  test('blocks are unchanged except the max_tokens the reasoning schemas reject', async () => {
    await withCatalog(() => assertBlocks(EXPECTED_BLOCKS_WITHCATALOG))
  })
})
