import { describe, expect, test } from 'bun:test'
import { EFFORT_OFF } from '../plugin/model-request-fields.js'
import { readRequestOptions } from '../plugin/request-options.js'

/**
 * Exactly what OpenCode 1.18 puts on the wire for a chosen variant, captured
 * from a live request. It sits at the top of the body in snake_case, not
 * nested under providerOptions — reading only the nested spelling meant the
 * dial never arrived and every request ran at the service default.
 */
const OPENCODE_BODY = {
  model: 'claude-sonnet-5',
  max_tokens: 32000,
  reasoning_effort: 'low',
  tool_choice: 'auto',
  stream: true,
  stream_options: { include_usage: true }
}

describe('the options OpenCode sends', () => {
  // These call the same function the request handler runs. An earlier version
  // of this file restated the reading logic and passed while the plugin looked
  // in the wrong place entirely — the dial did nothing for days.
  test('the variant is read from the top of the body', () => {
    expect(readRequestOptions(OPENCODE_BODY, 'claude-sonnet-5').requestedEffort).toBe('low')
  })

  test('off is a choice, not an absence', () => {
    const options = readRequestOptions(
      { ...OPENCODE_BODY, reasoning_effort: EFFORT_OFF },
      'claude-sonnet-5'
    )
    expect(options.thinkingDisabled).toBe(true)
    expect(options.think).toBe(false)
    expect(options.requestedEffort).toBeUndefined()
  })

  test('no variant reads as nothing, which is not the same as off', () => {
    const options = readRequestOptions({ model: 'claude-sonnet-5' }, 'claude-sonnet-5')
    expect(options.requestedEffort).toBeUndefined()
    expect(options.thinkingDisabled).toBe(false)
  })

  test('max_tokens is read from the top of the body too', () => {
    expect(readRequestOptions(OPENCODE_BODY, 'claude-sonnet-5').maxTokens).toBe(32000)
  })

  test('a missing or nonsense ceiling is left alone', () => {
    for (const max_tokens of [undefined, 0, -1, 'lots']) {
      expect(readRequestOptions({ max_tokens }, 'claude-sonnet-5').maxTokens).toBeUndefined()
    }
  })

  test('a -thinking model id still means adaptive', () => {
    expect(readRequestOptions({}, 'claude-sonnet-5-thinking').think).toBe(true)
  })
})

describe('describing something that was thrown', () => {
  test('an Error reads as its name and message', async () => {
    const { describeError } = await import('../plugin/describe-error.js')
    expect(describeError(new TypeError('bad input'))).toBe('TypeError: bad input')
  })

  test('an AWS SDK error is not an Error, and still says something', async () => {
    // These reduced to "[object Object]", which is a logged failure that looks
    // handled and tells you nothing a week later.
    const { describeError } = await import('../plugin/describe-error.js')
    const thrown = {
      name: 'ThrottlingException',
      message: 'Too many requests',
      $metadata: { httpStatusCode: 429 }
    }
    const described = describeError(thrown)

    expect(described).not.toContain('[object Object]')
    expect(described).toContain('ThrottlingException')
    expect(described).toContain('429')
  })

  test('an object with nothing familiar still beats [object Object]', async () => {
    const { describeError } = await import('../plugin/describe-error.js')
    expect(describeError({ weird: true })).toBe('{"weird":true}')
  })

  test('a cause is carried along', async () => {
    const { describeError } = await import('../plugin/describe-error.js')
    const e = new Error('outer', { cause: new Error('inner') })
    expect(describeError(e)).toContain('inner')
  })
})
