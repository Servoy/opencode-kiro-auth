import { describe, expect, test } from 'bun:test'
import { MODEL_MAPPING } from '../constants.js'
import { MODEL_SPECS } from '../plugin/model-registry.js'

/**
 * What Kiro publishes, from kiro.dev/docs/models on 2026-10-09.
 *
 * Deliberately NOT the account's own ListAvailableModels response. The catalog
 * is per-account — an API-key account and a subscription account are served
 * different models — so filtering the advertised list by one account's catalog
 * hides every model the other accounts do have. A model belongs here when Kiro
 * documents it; whether this particular user can reach it is the service's
 * call, and it answers with "Invalid model ID" rather than anything we could
 * have prevented by not offering it.
 */
const SERVED_BY_KIRO: Record<string, { context: number; output: number; rate: number }> = {
  auto: { context: 1000000, output: 64000, rate: 1 },
  'claude-haiku-4.5': { context: 200000, output: 64000, rate: 0.4 },
  'claude-opus-4.5': { context: 200000, output: 64000, rate: 2.2 },
  'claude-opus-4.6': { context: 1000000, output: 64000, rate: 2.2 },
  'claude-opus-4.7': { context: 1000000, output: 128000, rate: 2.2 },
  'claude-opus-4.8': { context: 1000000, output: 128000, rate: 2.2 },
  'claude-opus-5': { context: 1000000, output: 128000, rate: 2.2 },
  'claude-opus-5.5': { context: 1000000, output: 128000, rate: 2 },
  'claude-sonnet-4': { context: 200000, output: 64000, rate: 1.3 },
  'claude-sonnet-4.5': { context: 200000, output: 64000, rate: 1.3 },
  'claude-sonnet-4.6': { context: 1000000, output: 64000, rate: 1.3 },
  'claude-sonnet-5': { context: 1000000, output: 64000, rate: 1.3 },
  'claude-sonnet-5.5': { context: 1000000, output: 128000, rate: 1.3 },
  'gpt-5.6-luna': { context: 1000000, output: 128000, rate: 0.6 },
  'gpt-5.6-sol': { context: 1000000, output: 128000, rate: 4.4 },
  'gpt-5.6-terra': { context: 1000000, output: 128000, rate: 2.2 },
  // Experimental, US geography only, and a Kiro Excluded Model — but documented
  // on kiro.dev, which is the bar for this list (whether a given account can
  // reach it is the service's call, answered with "Invalid model ID").
  'kimi-k3': { context: 1000000, output: 131072, rate: 2.4 },
  'minimax-m2.1': { context: 196000, output: 64000, rate: 0.15 },
  'minimax-m2.5': { context: 196000, output: 64000, rate: 0.25 },
  'qwen3-coder-next': { context: 256000, output: 64000, rate: 0.05 },
  // Documented and available in US and EU on every tier, but absent from the
  // catalog an API-key account is served — which is why they belong to this
  // list rather than being derived from one account's response.
  'deepseek-3.2': { context: 128000, output: 64000, rate: 0.25 },
  'glm-5': { context: 200000, output: 64000, rate: 0.5 }
}

/**
 * Model ids Kiro has renamed away from. They stay resolvable so an old saved
 * config fails with a clear reason instead of "Unsupported model", but they are
 * never advertised, so they are not held to the catalog.
 */
const RETIRED_IDS = new Set([
  'CLAUDE_3_7_SONNET_20250219_V1_0',
  'AGI_NOVA_SWE_V1_5',
  'OPENAI_GPT_OSS_120B_1_0',
  'MINIMAX_MINIMAX_M2',
  'MOONSHOT_KIMI_K2_THINKING'
])

const rateOf = (advertised: string): number => Number(advertised.replace('x', ''))

describe('the mapping against what Kiro actually serves', () => {
  test('names no model the inference endpoint would refuse', () => {
    const invented = Object.entries(MODEL_MAPPING)
      .filter(([, kiroId]) => !(kiroId in SERVED_BY_KIRO) && !RETIRED_IDS.has(kiroId))
      .map(([ours, kiro]) => `${ours} -> ${kiro}`)

    expect(invented).toEqual([])
  })

  test('advertises only models the catalog lists', () => {
    const unlisted = Object.keys(MODEL_SPECS)
      .map((id) => MODEL_MAPPING[id] ?? id)
      .filter((kiroId) => !(kiroId in SERVED_BY_KIRO))

    expect(unlisted).toEqual([])
  })

  test('shows the rate Kiro actually charges', () => {
    // The multiplier is rendered into the model name the user picks from, so a
    // wrong one is a wrong price quote rather than a cosmetic slip.
    const wrong = Object.entries(MODEL_SPECS)
      .filter(([id, spec]) => {
        const served = SERVED_BY_KIRO[MODEL_MAPPING[id] ?? id]
        return served && rateOf(spec.rate) !== served.rate
      })
      .map(([id, spec]) => {
        const served = SERVED_BY_KIRO[MODEL_MAPPING[id] ?? id]!
        return `${id}: advertised ${spec.rate}, Kiro charges ${served.rate}x`
      })

    expect(wrong).toEqual([])
  })

  test('advertises the context window and output ceiling Kiro reports', () => {
    const wrong = Object.entries(MODEL_SPECS).flatMap(([id, spec]) => {
      const served = SERVED_BY_KIRO[MODEL_MAPPING[id] ?? id]
      if (!served) return []
      const problems: string[] = []
      if (spec.limit.context !== served.context) {
        problems.push(`${id}: context ${spec.limit.context}, Kiro says ${served.context}`)
      }
      if (spec.limit.output !== served.output) {
        problems.push(`${id}: output ${spec.limit.output}, Kiro says ${served.output}`)
      }
      return problems
    })

    expect(wrong).toEqual([])
  })
})
