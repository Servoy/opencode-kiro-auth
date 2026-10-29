import { describe, expect, test } from 'bun:test'
import { ResponseHandler, TransientStreamError } from '../core/request/response-handler.js'

const MODEL = 'claude-sonnet-4-5'

/** An SDK response whose event stream yields exactly these events, as the real
 *  CodeWhisperer streaming client hands them to handleSdkSuccess. */
function sdkResponse(events: unknown[]) {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const event of events) yield event
    })()
  }
}

describe('handleSdkSuccess non-streaming: content and token usage', () => {
  test('assembles plain assistant text into an OpenAI chat.completion', async () => {
    const response = await new ResponseHandler().handleSdkSuccess(
      sdkResponse([
        { assistantResponseEvent: { content: 'Hello' } },
        { assistantResponseEvent: { content: ', world' } }
      ]),
      MODEL,
      'conv-1',
      false
    )
    const body = await response.json()

    expect(body.object).toBe('chat.completion')
    expect(body.id).toBe('conv-1')
    expect(body.choices[0].message.content).toBe('Hello, world')
    expect(body.choices[0].finish_reason).toBe('stop')
  })

  test('maps Kiro TokenUsage fields onto the OpenAI usage block', async () => {
    // Kiro's TokenUsage has no `inputTokens`; prompt_tokens is the sum of
    // uncached + cacheRead + cacheWrite, which is the behaviour under test.
    const response = await new ResponseHandler().handleSdkSuccess(
      sdkResponse([
        { assistantResponseEvent: { content: 'hi' } },
        {
          metadataEvent: {
            tokenUsage: {
              uncachedInputTokens: 100,
              outputTokens: 20,
              cacheReadInputTokens: 30,
              cacheWriteInputTokens: 5
            }
          }
        }
      ]),
      MODEL,
      'conv-2',
      false
    )
    const body = await response.json()

    expect(body.usage).toEqual({
      prompt_tokens: 135,
      completion_tokens: 20,
      total_tokens: 155,
      prompt_tokens_details: { cached_tokens: 30 },
      cache_creation_input_tokens: 5
    })
  })

  test('reports zero usage when the stream carries no metadata event', async () => {
    const response = await new ResponseHandler().handleSdkSuccess(
      sdkResponse([{ assistantResponseEvent: { content: 'x' } }]),
      MODEL,
      'conv-3',
      false
    )
    const body = await response.json()

    expect(body.usage.prompt_tokens).toBe(0)
    expect(body.usage.completion_tokens).toBe(0)
    expect(body.usage.total_tokens).toBe(0)
  })

  test('fires onStreamEnd once the non-streaming body is built', async () => {
    // The caller releases the SDK client in onStreamEnd; for a non-streaming
    // response it must fire right after the body is assembled, not be dropped.
    let released = 0
    await new ResponseHandler().handleSdkSuccess(
      sdkResponse([{ assistantResponseEvent: { content: 'done' } }]),
      MODEL,
      'conv-4',
      false,
      undefined,
      () => {
        released++
      }
    )

    expect(released).toBe(1)
  })
})

describe('handleSdkSuccess streaming: onStreamEnd and error propagation', () => {
  test('fires onStreamEnd after the last streamed event is consumed', async () => {
    let released = 0
    const response = await new ResponseHandler().handleSdkSuccess(
      sdkResponse([
        { assistantResponseEvent: { content: 'a' } },
        { assistantResponseEvent: { content: 'b' } }
      ]),
      MODEL,
      'conv-5',
      true,
      undefined,
      () => {
        released++
      }
    )

    // The release only happens once the consumer drains the SSE body.
    const reader = response.body!.getReader()
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }

    expect(released).toBe(1)
    expect(text).toContain('data:')
  })

  test('still releases the client when the underlying stream throws after a chunk is out', async () => {
    // A stream that breaks after real output is on the wire must not leak the
    // client: onStreamEnd runs in the finally, so release happens on the error
    // path too. The content is long enough to clear the thinking-tag lookahead
    // buffer, so a chunk is genuinely emitted before the break.
    let released = 0
    const breaking = {
      generateAssistantResponseResponse: (async function* () {
        yield { assistantResponseEvent: { content: 'a real chunk of visible assistant text' } }
        throw new Error('socket closed')
      })()
    }

    const response = await new ResponseHandler().handleSdkSuccess(
      breaking,
      MODEL,
      'conv-6',
      true,
      undefined,
      () => {
        released++
      }
    )

    const reader = response.body!.getReader()
    let threw = false
    try {
      for (;;) {
        const { done } = await reader.read()
        if (done) break
      }
    } catch {
      threw = true
    }

    expect(threw).toBe(true)
    expect(released).toBe(1)
  })
})

describe('handleSdkSuccess streaming: transient failure before the first chunk', () => {
  test('a transient first-event failure is thrown as a retryable TransientStreamError, not committed to the body', async () => {
    // Kiro delivers MODEL_TEMPORARILY_UNAVAILABLE as the very first event, so
    // the iterator throws before anything is emitted. The whole request is
    // still safe to replay, so handleSdkSuccess throws it back to the caller's
    // retry loop instead of building a doomed stream.
    let released = 0
    const failingFirst = {
      generateAssistantResponseResponse: (async function* () {
        throw new Error(
          'The service is temporarily unavailable. Please try again later. (MODEL_TEMPORARILY_UNAVAILABLE)'
        )
        // eslint-disable-next-line no-unreachable
        yield { assistantResponseEvent: { content: 'never' } }
      })()
    }

    let caught: unknown
    try {
      await new ResponseHandler().handleSdkSuccess(
        failingFirst,
        MODEL,
        'conv-t1',
        true,
        undefined,
        () => {
          released++
        }
      )
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(TransientStreamError)
    expect((caught as TransientStreamError).reason).toContain('temporarily unavailable')
    // The client must still be released even though no stream ran.
    expect(released).toBe(1)
  })

  test('a non-transient first-event failure is rethrown unchanged, not reclassified as retryable', async () => {
    // A bad-model or credential failure before the first chunk must not be
    // swallowed into a retry — it rethrows as-is so the caller handles it.
    const failingFirst = {
      generateAssistantResponseResponse: (async function* () {
        throw new Error('Invalid model ID')
        // eslint-disable-next-line no-unreachable
        yield { assistantResponseEvent: { content: 'never' } }
      })()
    }

    let caught: unknown
    try {
      await new ResponseHandler().handleSdkSuccess(failingFirst, MODEL, 'conv-t2', true)
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(TransientStreamError)
    expect((caught as Error).message).toBe('Invalid model ID')
  })

  test('a transient failure AFTER the first chunk ends the stream and is never retried', async () => {
    // Once a chunk is out the body is committed — per the Smithy rule a started
    // stream cannot be replayed. The same transient reason that would retry
    // before the first chunk must only break the stream here, never throw a
    // TransientStreamError back to the caller. The content is long enough to
    // clear the thinking-tag lookahead so a chunk is genuinely emitted first.
    let released = 0
    const breakAfterFirst = {
      generateAssistantResponseResponse: (async function* () {
        // Two content events: the first clears the transformer's thinking-tag
        // lookahead so a chunk is genuinely yielded, committing the body,
        // before the second turn throws the transient failure.
        yield { assistantResponseEvent: { content: 'a real chunk of visible assistant text' } }
        yield { assistantResponseEvent: { content: ' and more text to flush the buffer' } }
        throw new Error('MODEL_TEMPORARILY_UNAVAILABLE')
      })()
    }

    // handleSdkSuccess resolves to a Response — it does NOT throw, because the
    // first chunk pulled cleanly.
    const response = await new ResponseHandler().handleSdkSuccess(
      breakAfterFirst,
      MODEL,
      'conv-t3',
      true,
      undefined,
      () => {
        released++
      }
    )

    const reader = response.body!.getReader()
    let text = ''
    let threw = false
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) text += new TextDecoder().decode(value)
      }
    } catch {
      threw = true
    }

    // The first chunk reached the client, then the stream errored.
    expect(text).toContain('data:')
    expect(threw).toBe(true)
    expect(released).toBe(1)
  })
})
