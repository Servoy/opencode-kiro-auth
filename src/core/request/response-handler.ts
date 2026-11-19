import { restoreToolName } from '../../infrastructure/transformers/tool-transformer.js'
import { isTransientStreamError } from '../../plugin/health.js'
import {
  guardStreamIdle,
  StreamIdleError,
  type IdleWatchdogOptions
} from '../../plugin/streaming/idle-watchdog.js'
import { transformSdkStream } from '../../plugin/streaming/sdk-stream-transformer.js'
import type { ToolNameMap } from '../../plugin/types.js'

interface AccumulatedToolCall {
  toolUseId: string
  name?: string
  input: string
}

/**
 * A transient stream failure Kiro delivered before the first chunk, so the
 * request is still safe to replay. Thrown while the caller's try/catch is live,
 * it routes back through the same backoff-and-switch an HTTP 503 takes; never
 * thrown once a chunk is out, since a started stream cannot be retried.
 */
export class TransientStreamError extends Error {
  override readonly name = 'TransientStreamError'
  constructor(readonly reason: string) {
    super(reason)
  }
}

export class ResponseHandler {
  /**
   * @param idle bounds the silence between stream events. Left out, the stream
   *   is read unguarded — the behaviour every caller had before the watchdog.
   */
  constructor(private idle?: IdleWatchdogOptions) {}

  /**
   * Turn a successful SDK response into the Response OpenCode reads.
   *
   * `onStreamEnd` fires once the response is fully consumed — after the last
   * streamed event, or immediately for a non-streaming body. The caller uses it
   * to release the SDK client: the stream is read lazily after this returns, so
   * releasing any earlier would free a client whose socket is still in use.
   *
   * @param onCredits called once with the credits Kiro metered for this
   *   response, after it is fully read; not called when Kiro sent none
   */
  async handleSdkSuccess(
    sdkResponse: any,
    model: string,
    conversationId: string,
    streaming: boolean,
    toolNameMap?: ToolNameMap,
    onStreamEnd?: () => void,
    onCredits?: (credits: number) => void
  ): Promise<Response> {
    if (streaming) {
      return this.handleSdkStreaming(
        sdkResponse,
        model,
        conversationId,
        toolNameMap,
        onStreamEnd,
        onCredits
      )
    }
    let response: Response
    try {
      response = await this.handleSdkNonStreaming(
        sdkResponse,
        model,
        conversationId,
        toolNameMap,
        onCredits
      )
    } catch (err) {
      onStreamEnd?.()
      // A non-streaming body is only handed back once it is complete, so a
      // stall leaves nothing emitted and the request stays replayable.
      if (err instanceof StreamIdleError) throw new TransientStreamError(err.message)
      throw err
    }
    onStreamEnd?.()
    return response
  }

  /**
   * The first chunk is pulled here, before the Response is built, so a
   * transient failure that Kiro delivers before any output is still inside the
   * caller's try/catch and can be replayed. Once the first chunk is in hand the
   * body is committed: the stream is wrapped around it and read lazily, and any
   * later failure can only end the stream — never retry it.
   */
  private async handleSdkStreaming(
    sdkResponse: any,
    model: string,
    conversationId: string,
    toolNameMap?: ToolNameMap,
    onStreamEnd?: () => void,
    onCredits?: (credits: number) => void
  ): Promise<Response> {
    const s = transformSdkStream(
      sdkResponse,
      model,
      conversationId,
      toolNameMap,
      onCredits,
      this.idle
    )

    let first: IteratorResult<any>
    try {
      first = await s.next()
    } catch (err) {
      // Nothing was emitted, so the request is safe to replay. Release the
      // client here — no stream will run to do it — and hand the caller a
      // retryable error for a transient reason, or rethrow anything else.
      onStreamEnd?.()
      const reason = err instanceof Error ? err.message : String(err)
      // A stall before the first chunk is the one stall that can be replayed in
      // full, so it rejoins the same backoff a 503 takes rather than ending the
      // turn. After the first chunk the watchdog can only end the stream.
      if (err instanceof StreamIdleError || isTransientStreamError(reason)) {
        throw new TransientStreamError(reason)
      }
      throw err
    }

    const encoder = new TextEncoder()
    return new Response(
      new ReadableStream({
        async start(c) {
          try {
            if (!first.done) {
              c.enqueue(encoder.encode(`data: ${JSON.stringify(first.value)}\n\n`))
              for await (const e of s) {
                c.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`))
              }
            }
            c.close()
          } catch (err) {
            c.error(err)
          } finally {
            onStreamEnd?.()
          }
        }
      }),
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
  }

  private async handleSdkNonStreaming(
    sdkResponse: any,
    model: string,
    conversationId: string,
    toolNameMap?: ToolNameMap,
    onCredits?: (credits: number) => void
  ): Promise<Response> {
    // For non-streaming SDK responses, collect all events
    let content = ''
    let credits: number | undefined
    const toolCallFragments = new Map<string, AccumulatedToolCall>()
    const toolCallOrder: string[] = []
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadInputTokens = 0
    let cacheWriteInputTokens = 0

    const eventStream = sdkResponse.generateAssistantResponseResponse
    if (eventStream) {
      // Nothing is handed back until the whole body is collected, so a stall
      // here hangs the caller just as one mid-stream does.
      const guarded = this.idle ? guardStreamIdle(eventStream, this.idle) : eventStream
      for await (const event of guarded) {
        if (event.assistantResponseEvent?.content) {
          content += event.assistantResponseEvent.content
        }
        if (event.toolUseEvent) {
          const fragment = event.toolUseEvent
          const toolUseId = fragment.toolUseId
          if (typeof toolUseId === 'string' && toolUseId.length > 0) {
            let accumulated = toolCallFragments.get(toolUseId)
            if (!accumulated) {
              accumulated = { toolUseId, input: '' }
              toolCallFragments.set(toolUseId, accumulated)
              toolCallOrder.push(toolUseId)
            }
            if (typeof fragment.name === 'string' && fragment.name.length > 0) {
              accumulated.name = fragment.name
            }
            if (fragment.input !== undefined) {
              accumulated.input +=
                typeof fragment.input === 'string'
                  ? fragment.input
                  : (JSON.stringify(fragment.input) ?? '')
            }
          }
        }
        if (event.metadataEvent?.tokenUsage) {
          // TokenUsage has no `inputTokens`; reading it always yielded 0.
          const tu = event.metadataEvent.tokenUsage
          inputTokens = tu.uncachedInputTokens || 0
          outputTokens = tu.outputTokens || 0
          cacheReadInputTokens = tu.cacheReadInputTokens || 0
          cacheWriteInputTokens = tu.cacheWriteInputTokens || 0
        }
        const metered = (event as { meteringEvent?: { usage?: unknown } }).meteringEvent?.usage
        if (typeof metered === 'number') credits = (credits ?? 0) + metered
      }
    }
    if (credits !== undefined) onCredits?.(credits)

    const toolCalls = toolCallOrder
      .map((toolUseId) => toolCallFragments.get(toolUseId))
      .filter(
        (toolCall): toolCall is AccumulatedToolCall & { name: string } =>
          typeof toolCall?.name === 'string'
      )

    const promptTokens = inputTokens + cacheReadInputTokens + cacheWriteInputTokens

    const oai: any = {
      id: conversationId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
        }
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: outputTokens,
        total_tokens: promptTokens + outputTokens,
        prompt_tokens_details: { cached_tokens: cacheReadInputTokens },
        cache_creation_input_tokens: cacheWriteInputTokens
      }
    }

    if (toolCalls.length > 0) {
      oai.choices[0].message.tool_calls = toolCalls.map((tc) => ({
        id: tc.toolUseId,
        type: 'function',
        function: {
          name: restoreToolName(tc.name, toolNameMap),
          arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input)
        }
      }))
    }

    return new Response(JSON.stringify(oai), {
      headers: { 'Content-Type': 'application/json' }
    })
  }
}
