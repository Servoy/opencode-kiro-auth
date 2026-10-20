import { describe, expect, test } from 'bun:test'
import {
  findOriginalToolCall,
  getContentText
} from '../infrastructure/transformers/message-transformer.js'

// The real functions, not a restatement: request.ts calls findOriginalToolCall
// to recover a tool call's original name when pairing a tool_result back to it,
// and getContentText is how every message's text is read across the transform
// pipeline. Both were exported but untested.

describe('findOriginalToolCall', () => {
  test('finds a call carried in an assistant message tool_calls array', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        tool_calls: [
          { id: 'call-1', function: { name: 'read_file' } },
          { id: 'call-2', function: { name: 'list_dir' } }
        ]
      }
    ]

    expect(findOriginalToolCall(messages, 'call-2')).toEqual({
      id: 'call-2',
      function: { name: 'list_dir' }
    })
  })

  test('finds a call carried as a tool_use part in array content', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me look' },
          { type: 'tool_use', id: 'use-9', name: 'grep', input: { pattern: 'x' } }
        ]
      }
    ]

    expect(findOriginalToolCall(messages, 'use-9')).toEqual({
      type: 'tool_use',
      id: 'use-9',
      name: 'grep',
      input: { pattern: 'x' }
    })
  })

  test('returns null when no assistant message holds the id', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', tool_calls: [{ id: 'other', function: { name: 'n' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'result' }
    ]

    expect(findOriginalToolCall(messages, 'call-1')).toBeNull()
  })

  test('ignores a matching id on a non-assistant message', () => {
    // A tool_result message carries the same id, but the ORIGINAL call lives on
    // the assistant turn; matching the tool message would return the wrong shape.
    const messages = [{ role: 'tool', tool_call_id: 'call-1', content: 'done' }]

    expect(findOriginalToolCall(messages, 'call-1')).toBeNull()
  })
})

describe('getContentText', () => {
  test('returns a plain string body unchanged', () => {
    expect(getContentText({ role: 'user', content: 'hello' })).toBe('hello')
  })

  test('joins only the text parts of an array body, dropping images and tool parts', () => {
    const message = {
      role: 'user',
      content: [
        { type: 'text', text: 'look at ' },
        { type: 'image', source: { bytes: new Uint8Array() } },
        { type: 'text', text: 'this' },
        { type: 'tool_use', id: 'x', name: 'n', input: {} }
      ]
    }

    expect(getContentText(message)).toBe('look at this')
  })

  test('falls back to a bare top-level text field', () => {
    expect(getContentText({ text: 'bare' })).toBe('bare')
  })

  test('is empty for a missing message or a part with no text', () => {
    expect(getContentText(null)).toBe('')
    expect(getContentText(undefined)).toBe('')
    expect(getContentText({ role: 'user', content: [{ type: 'text' }] })).toBe('')
  })

  test('reads a raw string argument directly', () => {
    expect(getContentText('direct' as unknown as Record<string, unknown>)).toBe('direct')
  })
})
