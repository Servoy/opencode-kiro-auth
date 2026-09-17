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

  test('every tool_use and tool_result keeps its counterpart after trimming', () => {
    // The service enforces the pairing both ways: a tool_result needs its
    // tool_use, and a tool_use needs a tool_result in the very next turn.
    // Trimming split pairs and produced both 400s in the field. Small caps
    // force the deep trim where the split happens.
    for (const seed of SEEDS) {
      for (const cap of [...CAPS, ...TRIM_CAPS]) {
        const state = build(conversation(seed), seed, cap).conversationState as any
        expect(orphanToolResults(state)).toEqual([])
        expect(orphanToolUses(state)).toEqual([])
      }
    }
  })

  test('an attachment-carrying pair keeps both halves reachable after a hard trim', () => {
    // The reported shape: an attachment-bearing turn is skipped by the pair
    // trimmer (attachments are spent last) while its neighbour is not, so the
    // pair splits — orphaning a result on one side and a use on the other.
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
    expect(orphanToolUses(state)).toEqual([])
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

// Every tool_use in history that the very next turn does not answer with a
// matching tool_result. The service requires the result immediately after, so
// this list must also always be empty.
function orphanToolUses(state: any): string[] {
  const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0
  const history = state.history ?? []
  // The current message answers the last history tool_use — it is not in the
  // history array, so fold its result ids in as the answer to the final entry.
  const currentIds = (
    state.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults ?? []
  ).map((tr: any) => tr.toolUseId)
  const orphans: string[] = []
  history.forEach((h: any, i: number) => {
    const answers = new Set(
      (history[i + 1]?.userInputMessage?.userInputMessageContext?.toolResults ?? []).map(
        (tr: any) => tr.toolUseId
      )
    )
    if (i === history.length - 1) for (const id of currentIds) answers.add(id)
    for (const tu of h.assistantResponseMessage?.toolUses ?? []) {
      if (!validId(tu.toolUseId) || !answers.has(tu.toolUseId)) orphans.push(String(tu.toolUseId))
    }
  })
  return orphans
}

describe('pruneOrphanToolResults, directly', () => {
  // The builder's shape: an assistant tool_use is answered by the *next* turn's
  // tool_result. Fixtures follow that order, because the service enforces it.
  const asstUses = (content: string, ...ids: string[]): any => ({
    assistantResponseMessage: { content, toolUses: ids.map((toolUseId) => ({ toolUseId })) }
  })
  const userResults = (content: string, ...ids: string[]): any => ({
    userInputMessage: {
      content,
      userInputMessageContext: { toolResults: ids.map((toolUseId) => ({ toolUseId })) }
    }
  })
  const userText = (content: string): any => ({ userInputMessage: { content } })

  test('keeps the matched result and drops only the orphan from a mixed answer turn', () => {
    // A user turn answering one live and one vanished tool_use keeps the live
    // result and its text, losing only the orphan.
    const history = [asstUses('', 'a'), userResults('answer', 'a', 'gone')]
    pruneOrphanToolResults(history)

    expect(history).toHaveLength(2)
    expect(
      history[1].userInputMessage.userInputMessageContext.toolResults.map((t: any) => t.toolUseId)
    ).toEqual(['a'])
    expect(history[1].userInputMessage.content).toBe('answer')
  })

  test('drops a tool_result whose tool_use trimming removed', () => {
    // The reported first bug: a result left with no tool_use before it. The
    // answer turn keeps its text, only shedding the orphaned result.
    const history = [userResults('leftover answer', 'gone'), userText('next')]
    pruneOrphanToolResults(history)

    expect(history).toHaveLength(2)
    expect(history[0].userInputMessage.userInputMessageContext).toBeUndefined()
    expect(history[0].userInputMessage.content).toBe('leftover answer')
  })

  test('drops a tool_use whose tool_result trimming removed', () => {
    // The mirror bug: an assistant tool_use with no answering next turn. The
    // assistant keeps its text, only shedding the unanswerable tool_use.
    const history = [asstUses('thinking out loud', 'gone'), userText('unrelated next')]
    pruneOrphanToolResults(history)

    expect(history).toHaveLength(2)
    expect(history[0].assistantResponseMessage.toolUses).toBeUndefined()
    expect(history[0].assistantResponseMessage.content).toBe('thinking out loud')
  })

  test('removes an entry left with neither results nor content', () => {
    const history = [userResults('   ', 'gone'), userText('next')]
    pruneOrphanToolResults(history)
    expect(history).toHaveLength(1)
    expect(history[0].userInputMessage.content).toBe('next')
  })

  test('removes a lone tool_use turn that nothing answers', () => {
    // A tool_use with no following turn at all cannot be answered, so it must
    // go — leaving it is exactly the 400 the mirror bug produced.
    const history = [asstUses('', 'gone')]
    pruneOrphanToolResults(history)
    expect(history).toHaveLength(0)
  })

  test('cascades: dropping an orphan result exposes an unanswerable tool_use', () => {
    // 'gone' has no tool_use → its result turn is emptied and removed → the
    // assistant that held 'orphaned' now has no answering next turn → its
    // tool_use is stripped too. Only the repeat pass reaches the second one.
    const history = [
      userResults('', 'gone'),
      asstUses('', 'orphaned'),
      userText('later, unrelated')
    ]
    pruneOrphanToolResults(history)
    expect(history).toEqual([userText('later, unrelated')])
  })

  test('leaves a valid tool_use/tool_result pair untouched', () => {
    const history = [asstUses('', 'a'), userResults('result', 'a'), userText('thanks')]
    const before = JSON.parse(JSON.stringify(history))
    pruneOrphanToolResults(history)
    expect(history).toEqual(before)
  })
})
