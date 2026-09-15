import { describe, expect, test } from 'bun:test'
import { isEffort } from '../plugin/effort.js'
import { EFFORT_OFF } from '../plugin/model-request-fields.js'

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

/** The reading the request handler performs, kept in one place to compare. */
function readEffort(body: any): string | undefined {
  const provOpts = body.providerOptions?.['kiro'] ?? body.providerOptions ?? {}
  return body.reasoning_effort ?? body.reasoningEffort ?? provOpts.reasoningEffort
}

describe('the options OpenCode sends', () => {
  test('the variant is read from the top of the body', () => {
    expect(readEffort(OPENCODE_BODY)).toBe('low')
    expect(isEffort(readEffort(OPENCODE_BODY))).toBe(true)
  })

  test('off arrives the same way', () => {
    expect(readEffort({ ...OPENCODE_BODY, reasoning_effort: EFFORT_OFF })).toBe(EFFORT_OFF)
  })

  test('a nested spelling still works', () => {
    // Kept so a host that sends it under providerOptions is not broken.
    expect(readEffort({ providerOptions: { kiro: { reasoningEffort: 'max' } } })).toBe('max')
  })

  test('no variant reads as nothing, which is not the same as off', () => {
    expect(readEffort({ model: 'claude-sonnet-5' })).toBeUndefined()
  })

  test('max_tokens is a top-level number too', () => {
    expect(OPENCODE_BODY.max_tokens).toBe(32000)
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
