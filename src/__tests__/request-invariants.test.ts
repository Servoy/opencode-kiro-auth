import { describe, expect, test } from 'bun:test'
import { transformToSdkRequest } from '../plugin/request.js'

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
    for (const seed of SEEDS) {
      const state = build(conversation(seed), seed, 250_000).conversationState as any
      const calls = new Set<string>()
      for (const h of state.history ?? []) {
        for (const tu of h.assistantResponseMessage?.toolUses ?? []) calls.add(tu.toolUseId)
        for (const tr of h.userInputMessage?.userInputMessageContext?.toolResults ?? []) {
          expect(calls.has(tr.toolUseId)).toBe(true)
        }
      }
    }
  })
})
