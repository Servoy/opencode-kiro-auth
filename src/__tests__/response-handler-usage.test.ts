import { describe, expect, test } from 'bun:test'
import { ResponseHandler } from '../core/request/response-handler.js'

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

  test('still releases the client when the underlying stream throws mid-flight', async () => {
    // A stream that breaks partway must not leak the client: onStreamEnd runs in
    // the finally, so release happens on the error path too.
    let released = 0
    const breaking = {
      generateAssistantResponseResponse: (async function* () {
        yield { assistantResponseEvent: { content: 'partial' } }
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
