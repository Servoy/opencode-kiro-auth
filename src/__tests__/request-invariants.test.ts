import { describe, expect, test } from 'bun:test'
import { pruneOrphanToolResults, transformToSdkRequest } from '../plugin/request.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')
const PDF = Buffer.from('%PDF-1.4 spec').toString('base64')
const auth: any = {
  access: 'a',
  refresh: 'r',
  expires: 0,
  authMethod: 'idc',
  region: 'eu-central-1'
}

const image = () => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } })
const document = () => ({
  type: 'file',
  file: { filename: 'spec.pdf', file_data: `data:application/pdf;base64,${PDF}` }
})
const text = (s: string) => ({ type: 'text', text: s })

/**
 * Conversations of many shapes, built from one seed so a failure can be
 * reproduced exactly. Example tests only ever encode the last bug found;
 * these assert what has to hold for every conversation, which is the only
 * kind of test that can catch the next one.
 */
function conversation(seed: number): any[] {
  const rand = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n
  const messages: any[] = []
  const turns = 2 + rand(14)

  for (let i = 0; i < turns; i++) {
    const parts: any[] = []
    const kind = rand(5)
    if (kind === 0) parts.push(image())
    else if (kind === 1) parts.push(document())
    else if (kind === 2) parts.push(text(`q${i} `), image())
    else parts.push(text('x'.repeat(1 + rand(40_000))))
    messages.push({ role: 'user', content: parts })

    if (rand(4) === 0) {
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: `t${i}`, name: 'read', input: {} }]
      })
      messages.push({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: `t${i}`, content: 'y'.repeat(1 + rand(5000)) }
        ]
      })
    } else {
      messages.push({ role: 'assistant', content: [text('a'.repeat(1 + rand(20_000)))] })
    }
  }
  messages.push({ role: 'user', content: [text('and now?')] })
  return messages
}

function build(messages: any[], seed: number, cap: number) {
  return transformToSdkRequest(
    { messages },
    'auto',
    auth,
    false,
    0,
    undefined,
    '/inv',
    true,
    `ses_inv_${seed}_${cap}`,
    cap
  )
}

const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1)
const CAPS = [60_000, 250_000, 5_000_000]
// Small caps force the trimmer to cut deep into history, which is where a
// tool_use/tool_result pair gets split. The live 400 came from a 5.6MB history
// trimmed to a 3.9MB cap, so the trim path must be exercised, not just skipped.
const TRIM_CAPS = [20_000, 40_000, 80_000, 150_000]

describe('what every request must satisfy, whatever the conversation', () => {
  test('history alternates user and assistant', () => {
    // The builder injects a placeholder turn rather than let two user entries
    // meet, so alternation is a rule this code keeps on purpose. Trimming used
    // to break it: one conversation came out as `uuaua`.
    for (const seed of SEEDS) {
      for (const cap of CAPS) {
        const state = build(conversation(seed), seed, cap).conversationState as any
        const roles = (state.history ?? []).map((h: any) => (h.userInputMessage ? 'u' : 'a'))
        for (let i = 1; i < roles.length; i++) {
          expect(`seed=${seed} cap=${cap} roles=${roles.join('')}`).toBe(
            roles[i] === roles[i - 1]
              ? 'ALTERNATION BROKEN'
              : `seed=${seed} cap=${cap} roles=${roles.join('')}`
          )
        }
      }
    }
  })

  test('no entry is sent with empty content', () => {
    // An entry whose content is empty reads as nothing and takes its
    // attachment with it.
    for (const seed of SEEDS) {
      for (const cap of CAPS) {
        const state = build(conversation(seed), seed, cap).conversationState as any
        for (const entry of state.history ?? []) {
          const content = entry.userInputMessage?.content ?? entry.assistantResponseMessage?.content
          expect(typeof content === 'string' && content.trim().length > 0).toBe(true)
        }
        expect(state.currentMessage.userInputMessage.content.trim().length).toBeGreaterThan(0)
      }
    }
  })

  test('an attachment is either still there or said to be gone', () => {
    // Silently dropping one lets the model answer about a file it never got.
    for (const seed of SEEDS) {
      const messages = conversation(seed)
      const sent =
        JSON.stringify(messages).includes('image_url') ||
        JSON.stringify(messages).includes('application/pdf')
      if (!sent) continue

      const state = build(messages, seed, 60_000).conversationState as any
      const current = state.currentMessage.userInputMessage
      const kept =
        (current.images ?? []).length +
        (current.documents ?? []).length +
        (state.history ?? []).reduce(
          (n: number, h: any) =>
            n +
            (h.userInputMessage?.images ?? []).length +
            (h.userInputMessage?.documents ?? []).length,
          0
        )
      if (kept === 0) {
        expect(current.content).toContain('attachment(s) dropped')
      }
    }
  })

  test('a tool result never travels without the call that produced it', () => {
    // Every tool_result — in history AND in the current message — must have a
    // matching tool_use the service can still see. The live 400 was exactly
    // this: trimming split a pair, leaving `messages.0.content.5` with a
    // tool_use_id whose tool_use had been dropped. Small caps force the deep
    // trim where the split happens.
    for (const seed of SEEDS) {
      for (const cap of [...CAPS, ...TRIM_CAPS]) {
        const state = build(conversation(seed), seed, cap).conversationState as any
        expect(orphanToolResults(state)).toEqual([])
      }
    }
  })

  test('a tool_use in an attachment-carrying pair keeps its result reachable', () => {
    // The reported shape: an attachment-bearing turn is skipped by the pair
    // trimmer (attachments are spent last), but its neighbour — an assistant
    // turn holding the matching tool_use — is not, so the pair splits. Build a
    // conversation that puts a tool_use next to an image turn and trim hard.
    const messages: any[] = []
    for (let i = 0; i < 30; i++) {
      messages.push({ role: 'user', content: [text(`turn ${i} ` + 'x'.repeat(3000))] })
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: `call-${i}`, name: 'read', input: { i } }]
      })
      messages.push({
        role: 'user',
        content: [
          image(),
          { type: 'tool_result', tool_use_id: `call-${i}`, content: 'r'.repeat(2000) }
        ]
      })
    }
    messages.push({ role: 'user', content: [text('and now?')] })

    const state = build(messages, 999, 40_000).conversationState as any
    expect(orphanToolResults(state)).toEqual([])
  })
})

// Every toolUseId referenced by a tool_result — in history or the current
// message — that no surviving tool_use provides. The service rejects any such
// orphan with a 400, so the list must always be empty. Only a real, non-empty
// string id counts as a match: a tool_use or tool_result whose id went missing
// (undefined or '') is itself invalid, and treating undefined as a match on
// both sides would hide a payload the service would reject.
function orphanToolResults(state: any): string[] {
  const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0
  const calls = new Set<string>()
  for (const h of state.history ?? []) {
    for (const tu of h.assistantResponseMessage?.toolUses ?? []) {
      if (validId(tu.toolUseId)) calls.add(tu.toolUseId)
    }
  }
  const orphans: string[] = []
  const check = (trs: any[] | undefined): void => {
    for (const tr of trs ?? []) {
      if (!validId(tr.toolUseId) || !calls.has(tr.toolUseId)) orphans.push(String(tr.toolUseId))
    }
  }
  for (const h of state.history ?? []) {
    check(h.userInputMessage?.userInputMessageContext?.toolResults)
  }
  check(state.currentMessage.userInputMessage?.userInputMessageContext?.toolResults)
  return orphans
}

describe('pruneOrphanToolResults, directly', () => {
  const userWithResults = (content: string, ...ids: string[]): any => ({
    userInputMessage: {
      content,
      userInputMessageContext: { toolResults: ids.map((toolUseId) => ({ toolUseId })) }
    }
  })
  const assistantWithUses = (...ids: string[]): any => ({
    assistantResponseMessage: { toolUses: ids.map((toolUseId) => ({ toolUseId })) }
  })

  test('keeps the matched results and drops only the orphaned one from a mixed entry', () => {
    // The kept.length > 0 branch: an entry carrying one live and one orphaned
    // result keeps the live one and its content, losing only the orphan.
    const history = [assistantWithUses('a'), userWithResults('answer', 'a', 'gone')]
    pruneOrphanToolResults(history)

    expect(history).toHaveLength(2)
    const trs = history[1].userInputMessage.userInputMessageContext.toolResults
    expect(trs.map((t: any) => t.toolUseId)).toEqual(['a'])
    expect(history[1].userInputMessage.content).toBe('answer')
  })

  test('keeps an emptied entry that still carries text, only dropping its context', () => {
    // No live results, but real content: the turn stays (its text is history),
    // and only the now-empty context is removed.
    const history = [userWithResults('still says something', 'gone')]
    pruneOrphanToolResults(history)

    expect(history).toHaveLength(1)
    expect(history[0].userInputMessage.userInputMessageContext).toBeUndefined()
    expect(history[0].userInputMessage.content).toBe('still says something')
  })

  test('removes an entry left with neither results nor content', () => {
    const history = [userWithResults('   ', 'gone')]
    pruneOrphanToolResults(history)
    expect(history).toHaveLength(0)
  })

  test('cascades: dropping an orphan turn strips a newly-leading assistant and reprunes', () => {
    // The first turn's result is a true orphan (no tool_use provides "gone")
    // and its content is empty → removed → the assistant holding "live" now
    // leads → stripped (assistant can't lead) → the tool_result pointing at
    // "live" is now orphaned too, which only a repeat pass catches. A single
    // pass would leave that second orphan behind and the service would 400.
    const history = [
      userWithResults('', 'gone'),
      assistantWithUses('live'),
      userWithResults('', 'live')
    ]
    pruneOrphanToolResults(history)
    expect(history).toHaveLength(0)
  })

  test('leaves a valid history untouched', () => {
    const history = [
      userWithResults('q', 'a'),
      assistantWithUses('a'),
      { userInputMessage: { content: 'thanks' } }
    ]
    const before = JSON.parse(JSON.stringify(history))
    pruneOrphanToolResults(history)
    expect(history).toEqual(before)
  })

  test('leaves a deliberately assistant-led lone tool_call turn alone', () => {
    // The builder emits a lone assistant tool_call turn on purpose; with no
    // orphaned tool_result to trigger a removal, prune must not touch it.
    const history = [assistantWithUses('a')]
    pruneOrphanToolResults(history)
    expect(history).toEqual([assistantWithUses('a')])
  })
})
