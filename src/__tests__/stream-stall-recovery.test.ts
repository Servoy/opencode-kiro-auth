import { describe, expect, test } from 'bun:test'
import { ResponseHandler, TransientStreamError } from '../core/request/response-handler.js'

const MODEL = 'claude-sonnet-4-5'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * An SDK response whose event stream goes silent after `emitted` events, the
 * way Kiro holds a connection open without ever sending the rest of an answer.
 */
function stallingSdkResponse(emitted: unknown[], silenceMs = 400) {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const event of emitted) yield event
      await sleep(silenceMs)
    })()
  }
}

const IDLE = { hardMs: 60, softMs: 30 }

describe('a stalled response stream', () => {
  test('before the first chunk it is retryable, so the request can be replayed', async () => {
    const handler = new ResponseHandler(IDLE)
    let released = 0

    const run = handler.handleSdkSuccess(
      stallingSdkResponse([]),
      MODEL,
      'conv-stall-1',
      true,
      undefined,
      () => released++
    )

    await expect(run).rejects.toBeInstanceOf(TransientStreamError)
    // No stream will run to release the pooled SDK client, so the handler must.
    expect(released).toBe(1)
  })

  test('after the first chunk it ends the stream instead of hanging', async () => {
    const handler = new ResponseHandler(IDLE)
    let released = 0

    // Two events, because the transformer holds a single short delta back in
    // its thinking-tag buffer and would still be pre-first-chunk on one.
    const response = await handler.handleSdkSuccess(
      stallingSdkResponse([
        { assistantResponseEvent: { content: 'partial answer' } },
        { assistantResponseEvent: { content: ' that stops here' } }
      ]),
      MODEL,
      'conv-stall-2',
      true,
      undefined,
      () => released++
    )

    const reader = response.body!.getReader()
    const firstChunk = await reader.read()
    expect(firstChunk.done).toBe(false)
    const drain = async () => {
      for (;;) {
        const { done } = await reader.read()
        if (done) return
      }
    }
    await expect(drain()).rejects.toThrow(/stream stalled/)
    expect(released).toBe(1)
  })

  test('a non-streaming body that never completes is retryable too', async () => {
    const handler = new ResponseHandler(IDLE)

    const run = handler.handleSdkSuccess(
      stallingSdkResponse([{ assistantResponseEvent: { content: 'partial' } }]),
      MODEL,
      'conv-stall-3',
      false
    )

    await expect(run).rejects.toBeInstanceOf(TransientStreamError)
  })

  test('a gap shorter than the budget is left alone', async () => {
    const handler = new ResponseHandler(IDLE)

    const response = await handler.handleSdkSuccess(
      {
        generateAssistantResponseResponse: (async function* () {
          yield { assistantResponseEvent: { content: 'one' } }
          await sleep(20)
          yield { assistantResponseEvent: { content: ' two' } }
        })()
      },
      MODEL,
      'conv-ok',
      false
    )

    const body = await response.json()
    expect(body.choices[0].message.content).toBe('one two')
  })

  test('without a configured budget the stream is read unguarded', async () => {
    // The watchdog is opt-in: a handler built without one must behave exactly
    // as it did before, so an existing caller cannot start failing on a gap.
    const handler = new ResponseHandler()

    const response = await handler.handleSdkSuccess(
      {
        generateAssistantResponseResponse: (async function* () {
          await sleep(120)
          yield { assistantResponseEvent: { content: 'slow but fine' } }
        })()
      },
      MODEL,
      'conv-unguarded',
      false
    )

    const body = await response.json()
    expect(body.choices[0].message.content).toBe('slow but fine')
  })
})
