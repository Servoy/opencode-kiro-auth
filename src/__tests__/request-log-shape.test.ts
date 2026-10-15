import { describe, expect, test } from 'bun:test'
import { systemPromptLength } from '../core/request/request-handler.js'

describe('measuring the system prompt for the request log', () => {
  // The [IN] line carries systemChars so that a prompt nobody expected to be
  // large can be spotted. OpenCode sends system as an array of text blocks, and
  // counting only the bare-string shape reported zero on every request that had
  // one — wrong precisely when the number is being read to explain a payload.
  test('counts the blocks OpenCode actually sends', () => {
    expect(
      systemPromptLength([
        { type: 'text', text: 'You are a helpful assistant.' },
        { type: 'text', text: 'Be concise.' }
      ])
    ).toBe('You are a helpful assistant.'.length + 'Be concise.'.length)
  })

  test('still counts a plain string', () => {
    expect(systemPromptLength('Be concise.')).toBe('Be concise.'.length)
  })

  test('reads zero when there is no system prompt at all', () => {
    expect(systemPromptLength(undefined)).toBe(0)
    expect(systemPromptLength(null)).toBe(0)
    expect(systemPromptLength([])).toBe(0)
    expect(systemPromptLength(42)).toBe(0)
  })

  test('skips a block that carries no text rather than counting undefined', () => {
    expect(systemPromptLength([{ type: 'text' }, { type: 'text', text: 'ok' }])).toBe(2)
  })
})
