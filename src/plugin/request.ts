import * as crypto from 'crypto'
import { KIRO_CONSTANTS, extractRegionFromArn } from '../constants.js'
import {
  buildHistory,
  extractToolNamesFromHistory,
  historyHasToolCalling,
  injectSystemPrompt
} from '../infrastructure/transformers/history-builder.js'
import {
  findOriginalToolCall,
  getContentText,
  mergeAdjacentMessages
} from '../infrastructure/transformers/message-transformer.js'
import {
  convertToolsToCodeWhisperer,
  createToolNameRegistry,
  deduplicateToolResults
} from '../infrastructure/transformers/tool-transformer.js'
import { convertDocumentsToKiroFormat, extractAllDocuments } from './document-handler.js'
import { getEffectiveEffort } from './effort.js'
import { imageCache } from './image-cache.js'
import {
  MAX_KIRO_IMAGES,
  convertImagesToKiroFormat,
  extractAllImages,
  extractTextFromParts,
  type KiroImage
} from './image-handler.js'
import * as logger from './logger.js'
import { buildModelRequestFields } from './model-request-fields.js'
import { resolveKiroModel } from './models.js'
import { resolveKiroEndpoint } from './sdk-client.js'
import { kiroDb } from './storage/sqlite.js'
import type {
  CodeWhispererRequest,
  Effort,
  KiroAuthDetails,
  SdkPreparedRequest,
  ToolNameMap
} from './types'

/**
 * Look up or mint a stable convId for this conversation.
 *
 * A host session is one conversation, so when the host gives us a session id
 * that alone identifies it. Mixing the first message's text into the key made
 * the identity depend on text that legitimately changes — reverting a message,
 * editing one, or compacting the history all rewrote it, and Kiro then saw a
 * brand new conversation that remembered nothing. Without a session id the
 * text is all we have to tell two conversations in a directory apart.
 */
function deriveConversationIds(
  workspace: string,
  firstUserContent: string,
  hasSessionId: boolean
): { convId: string; agentContinuationId: string; fingerprint: string } {
  const identity = hasSessionId ? workspace : workspace + '\0' + (firstUserContent || '_empty_')
  const fingerprint = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32)

  const existing = kiroDb.getConversationId(workspace, fingerprint)
  if (existing) {
    if (!existing.agentContinuationId) {
      existing.agentContinuationId = crypto.randomUUID()
      kiroDb.setConversationId(
        workspace,
        fingerprint,
        existing.convId,
        existing.agentContinuationId
      )
    }
    return { ...existing, fingerprint }
  }

  const convId = crypto.randomUUID()
  const agentContinuationId = crypto.randomUUID()
  kiroDb.setConversationId(workspace, fingerprint, convId, agentContinuationId)
  return { convId, agentContinuationId, fingerprint }
}

interface TransformResult {
  request: CodeWhispererRequest
  resolved: string
  convId: string
  agentContinuationId: string
  fingerprint: string
  toolNameMap: ToolNameMap
}

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

function buildCodeWhispererRequest(
  body: any,
  model: string,
  auth: KiroAuthDetails,
  think = false,
  budget = 20000,
  showToast?: ToastFunction,
  workspace = '',
  carryForward = true,
  sessionId?: string,
  maxPayloadBytes = 5_000_000
): TransformResult {
  const req = typeof body === 'string' ? JSON.parse(body) : body
  const { messages, tools, system } = req
  if (!messages || messages.length === 0) throw new Error('No messages')

  const systemMsgs = messages.filter((m: any) => m.role === 'system')
  const otherMsgs = messages.filter((m: any) => m.role !== 'system')
  let sys = system || ''
  if (systemMsgs.length > 0) {
    const extractedSystem = systemMsgs.map((m: any) => getContentText(m)).join('\n\n')
    sys = sys ? `${sys}\n\n${extractedSystem}` : extractedSystem
  }
  if (think) {
    const pfx = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`
    sys = sys.includes('<thinking_mode>') ? sys : sys ? `${pfx}\n${sys}` : pfx
  }
  const msgs = mergeAdjacentMessages([...otherMsgs])
  const lastMsg = msgs[msgs.length - 1]
  if (lastMsg && lastMsg.role === 'assistant' && getContentText(lastMsg) === '{') msgs.pop()

  const firstUserMsg = msgs.find((m: any) => m.role === 'user')
  // Use text only — image bytes in the content array would change the
  // fingerprint once OpenCode strips them on subsequent turns.
  const firstUserContent = firstUserMsg
    ? typeof firstUserMsg.content === 'string'
      ? firstUserMsg.content
      : extractTextFromParts(firstUserMsg.content)
    : ''
  const workspaceKey = sessionId ? `sess:${sessionId}` : workspace
  // logger.debug() already gates on DEBUG/OPENCODE_LOG_LEVEL internally; no
  // need to duplicate that check here since the log line itself is cheap.
  logger.debug(`[CONV] ws=${workspaceKey} sessionId=${sessionId ?? 'none'} msgs=${msgs.length}`)
  const { convId, agentContinuationId, fingerprint } = deriveConversationIds(
    workspaceKey,
    firstUserContent,
    !!sessionId
  )
  const resolved = resolveKiroModel(model)
  const normalizedTools = Array.isArray(tools) ? tools : []
  const toolNameRegistry = createToolNameRegistry(normalizedTools)
  const cwTools = convertToolsToCodeWhisperer(normalizedTools, toolNameRegistry)
  let history = buildHistory(msgs, resolved)

  const curMsg = msgs[msgs.length - 1]
  if (!curMsg) throw new Error('Empty')

  const isRealUserMsg =
    curMsg.role === 'user' &&
    !(Array.isArray(curMsg.content) && curMsg.content.some((p: any) => p.type === 'tool_result'))

  if (isRealUserMsg && msgs.length >= 2) {
    const prevMsg = msgs[msgs.length - 2]
    if (prevMsg?.role === 'assistant') {
      const lastHistEntry = history[history.length - 1]
      const historyEndsWithUser = lastHistEntry?.userInputMessage
      if (historyEndsWithUser) {
        let prevText = ''
        if (Array.isArray(prevMsg.content)) {
          for (const p of prevMsg.content) {
            if (p.type === 'text') prevText += p.text || ''
          }
        } else prevText = getContentText(prevMsg)
        if (prevText) {
          history.push({ assistantResponseMessage: { content: prevText } })
        }
      }
    }
  }

  history = injectSystemPrompt(history, sys, resolved)
  let curContent = ''
  const curTrs: any[] = []
  const curImgs: any[] = []
  const curDocs: any[] = []

  if (curMsg.role === 'assistant') {
    const arm: any = { content: '' }
    let th = ''
    if (Array.isArray(curMsg.content)) {
      for (const p of curMsg.content) {
        if (p.type === 'text') arm.content += p.text || ''
        else if (p.type === 'thinking') th += p.thinking || p.text || ''
        else if (p.type === 'tool_use') {
          if (!arm.toolUses) arm.toolUses = []
          arm.toolUses.push({ input: p.input, name: p.name, toolUseId: p.id })
        }
      }
    } else arm.content = getContentText(curMsg)
    if ((curMsg as any).tool_calls && Array.isArray((curMsg as any).tool_calls)) {
      if (!arm.toolUses) arm.toolUses = []
      for (const tc of (curMsg as any).tool_calls) {
        arm.toolUses.push({
          input:
            typeof tc.function?.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : tc.function?.arguments,
          name: tc.function?.name,
          toolUseId: tc.id
        })
      }
    }
    if (th)
      arm.content = arm.content
        ? `<thinking>${th}</thinking>\n\n${arm.content}`
        : `<thinking>${th}</thinking>`

    if (arm.content || arm.toolUses) {
      history.push({ assistantResponseMessage: arm })
    }
    curContent = '[system: conversation continues]'
  } else {
    const prev = history[history.length - 1]
    if (prev && !prev.assistantResponseMessage)
      history.push({ assistantResponseMessage: { content: '[system: conversation continues]' } })
    if (curMsg.role === 'tool') {
      if (curMsg.tool_results) {
        for (const tr of curMsg.tool_results)
          curTrs.push({
            content: [{ text: getContentText(tr) }],
            status: 'success',
            toolUseId: tr.tool_call_id
          })
      } else {
        curTrs.push({
          content: [{ text: getContentText(curMsg) }],
          status: 'success',
          toolUseId: curMsg.tool_call_id
        })
      }
    } else if (Array.isArray(curMsg.content)) {
      curContent = extractTextFromParts(curMsg.content)

      for (const p of curMsg.content) {
        if (p.type === 'tool_result') {
          curTrs.push({
            content: [{ text: getContentText(p.content || p) }],
            status: 'success',
            toolUseId: p.tool_use_id
          })
        }
      }

      const unifiedImages = extractAllImages(curMsg.content)
      if (unifiedImages.length > 0) {
        const { images, omitted } = convertImagesToKiroFormat(unifiedImages)
        curImgs.push(...images)
        if (omitted > 0) {
          curContent += `\n\n[${omitted} image(s) omitted due to API limits]`
        }
      }

      const unifiedDocuments = extractAllDocuments(curMsg.content)
      if (unifiedDocuments.length > 0) {
        const { documents, omitted } = convertDocumentsToKiroFormat(unifiedDocuments)
        curDocs.push(...documents)
        if (omitted > 0) {
          curContent += `\n\n[${omitted} document(s) omitted due to API limits]`
        }
      }
    } else curContent = getContentText(curMsg)
    if (!curContent)
      curContent = curTrs.length ? 'Tool results provided.' : '[system: conversation continues]'
  }
  const request: CodeWhispererRequest = {
    conversationState: {
      agentContinuationId,
      agentTaskType: 'vibe',
      chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
      conversationId: convId,
      currentMessage: {
        userInputMessage: {
          content: curContent,
          modelId: resolved,
          origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
        }
      }
    }
  }
  if (auth.profileArn) request.profileArn = auth.profileArn
  const toolUsesInHistory = history.flatMap((h) => h.assistantResponseMessage?.toolUses || [])
  const allToolUseIdsInHistory = new Set(toolUsesInHistory.map((tu) => tu.toolUseId))
  const finalCurTrs: any[] = []
  const orphanedTrs: any[] = []
  for (const tr of curTrs) {
    if (allToolUseIdsInHistory.has(tr.toolUseId)) finalCurTrs.push(tr)
    else {
      const originalCall = findOriginalToolCall(messages, tr.toolUseId)
      if (originalCall) {
        orphanedTrs.push({
          call: {
            name: originalCall.name || originalCall.function?.name || 'tool',
            toolUseId: tr.toolUseId,
            input:
              originalCall.input ||
              (originalCall.function?.arguments ? JSON.parse(originalCall.function.arguments) : {})
          },
          result: tr
        })
      } else {
        curContent += `\n\n[Output for tool call ${tr.toolUseId}]:\n${tr.content?.[0]?.text || ''}`
      }
    }
  }
  if (orphanedTrs.length > 0) {
    const prev = history[history.length - 1]
    if (!prev || prev.assistantResponseMessage) {
      history.push({
        userInputMessage: {
          content: 'Running tools...',
          modelId: resolved,
          origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
        }
      })
    }
    history.push({
      assistantResponseMessage: {
        content: 'I will execute the following tools.',
        toolUses: orphanedTrs.map((o) => o.call)
      }
    })
    finalCurTrs.push(...orphanedTrs.map((o) => o.result))
  }

  // CodeWhisperer returns the names it received. Rewrite historical tool calls with the
  // same per-request registry used by current tool specifications so replay stays valid.
  for (const entry of history) {
    for (const toolUse of entry.assistantResponseMessage?.toolUses || []) {
      if (typeof toolUse.name === 'string' && toolUse.name.length > 0) {
        toolUse.name = toolNameRegistry.toWire(toolUse.name)
      }
    }
  }
  if (history.length > 0) (request.conversationState as any).history = history

  const uim = request.conversationState.currentMessage.userInputMessage
  if (uim) {
    uim.content = curContent
    if (curImgs.length) uim.images = curImgs
    if (curDocs.length) uim.documents = curDocs
    const ctx: any = {}
    if (finalCurTrs.length) ctx.toolResults = deduplicateToolResults(finalCurTrs)
    if (cwTools.length) ctx.tools = cwTools
    if (Object.keys(ctx).length) uim.userInputMessageContext = ctx
    const hasToolsInHistory = historyHasToolCalling(history)
    if (hasToolsInHistory) {
      const toolNamesInHistory = extractToolNamesFromHistory(history)
      if (toolNamesInHistory.size > 0) {
        const existingTools = uim.userInputMessageContext?.tools || []
        const existingToolNames = new Set(
          existingTools.map((t: any) => t.toolSpecification?.name).filter(Boolean)
        )
        const missingToolNames = Array.from(toolNamesInHistory).filter(
          (name) => !existingToolNames.has(name)
        )
        if (missingToolNames.length > 0) {
          const placeholderTools = missingToolNames.map((name) => ({
            toolSpecification: {
              name,
              description: 'Tool',
              inputSchema: { json: { type: 'object', properties: {} } }
            }
          }))
          if (!uim.userInputMessageContext) uim.userInputMessageContext = {}
          uim.userInputMessageContext.tools = [...existingTools, ...placeholderTools]
        }
      }
    }
  }

  // Strip empty toolUses arrays from history (Kiro quirk)
  for (const h of history) {
    if (h.assistantResponseMessage?.toolUses && h.assistantResponseMessage.toolUses.length === 0) {
      delete h.assistantResponseMessage.toolUses
    }
  }

  // Trim history if the payload approaches Kiro's request-size limit.
  // Kiro rejects oversized payloads with CONTENT_LENGTH_EXCEEDS_THRESHOLD. The
  // hard limit is structure-dependent (verified against the live API): a single
  // message survives up to ~7.6MB, but many-entry histories are rejected as low
  // as ~5.9MB. The configurable maxPayloadBytes (default 5MB) stays below the
  // lowest observed failure. It was 4MB while attachments were measured eight
  // times too large; with that corrected, 4MB rejected a 3MB screenshot that
  // the service would have taken.
  // Compute per-entry sizes once and shrink incrementally to avoid O(N²)
  // re-stringifying the full request on every iteration.
  const MAX_PAYLOAD_BYTES = maxPayloadBytes
  const trimStartLen = history.length
  let trimSizeBefore = 0
  let trimSizeAfter = 0
  let droppedAttachments = 0
  if (history.length > 0) {
    const sizes = history.map((h) => wireSize(h) + 1)
    const baseRequest: any = { ...request, conversationState: { ...request.conversationState } }
    delete baseRequest.conversationState.history
    let totalSize = wireSize(baseRequest) + 2 // for `"history":[]`
    for (const s of sizes) totalSize += s
    trimSizeBefore = totalSize

    // An attachment is only ever sent on the turn it arrived, so dropping the
    // entry that carries it loses it from the conversation for good. Spend the
    // text-only turns first and come back for these only if still over cap.
    const attachmentCount = (h: any): number =>
      (h?.userInputMessage?.documents?.length ?? 0) + (h?.userInputMessage?.images?.length ?? 0)
    const carriesAttachment = (h: any): boolean => attachmentCount(h) > 0

    // In pairs, because history alternates user and assistant and the builder
    // goes out of its way to keep it that way — it injects a placeholder turn
    // rather than let two user entries meet. Removing one entry at a time
    // undid that: a 200KB cap over an image-bearing conversation produced
    // `uuaua`, a shape the service is never sent by anything else.
    for (
      let i = 0;
      history.length > 2 && totalSize > MAX_PAYLOAD_BYTES && i + 1 < history.length;
    ) {
      if (carriesAttachment(history[i]) || carriesAttachment(history[i + 1])) {
        i += 2
        continue
      }
      totalSize -= (sizes[i] || 0) + (sizes[i + 1] || 0)
      sizes.splice(i, 2)
      history.splice(i, 2)
    }

    // Down to an empty history if need be: stopping short left long sessions
    // re-sending a payload the service had already rejected.
    while (history.length > 0 && totalSize > MAX_PAYLOAD_BYTES) {
      // Drop the two oldest entries (typically user + assistant pair).
      droppedAttachments += attachmentCount(history[0]) + attachmentCount(history[1])
      totalSize -= (sizes.shift() || 0) + (sizes.shift() || 0)
      history.splice(0, 2)

      // Strip leading orphans: assistantResponseMessage can't start the history.
      while (history.length > 0 && history[0]?.assistantResponseMessage) {
        totalSize -= sizes.shift() || 0
        history.shift()
      }

      // Strip leading toolResult-only userInputMessages whose toolUseIds are gone.
      const toolUseIds = new Set<string>(
        history.flatMap(
          (h) => h.assistantResponseMessage?.toolUses?.map((tu: any) => tu.toolUseId) ?? []
        )
      )
      while (history.length > 0) {
        const trs = history[0]?.userInputMessage?.userInputMessageContext?.toolResults
        if (!trs) break
        const allMatched = trs.every((tr: any) => toolUseIds.has(tr.toolUseId))
        if (allMatched) break
        totalSize -= sizes.shift() || 0
        history.shift()
      }
    }
    trimSizeAfter = totalSize
  }

  if (trimStartLen !== history.length) {
    logger.debug(
      `[TRIM] history ${trimStartLen}→${history.length} entries, ~${Math.round(trimSizeBefore / 1024)}KB exceeded ${Math.round(MAX_PAYLOAD_BYTES / 1024)}KB cap`
    )
  }

  // An attachment is only sent on the turn it arrives, so one dropped here is
  // gone from the conversation. Say so rather than let the model answer about
  // a file it never received.
  if (droppedAttachments > 0 && uim) {
    uim.content += `\n\n[${droppedAttachments} attachment(s) dropped: this conversation exceeds Kiro's request size limit]`
    logger.warn(
      `[TRIM] dropped ${droppedAttachments} attachment(s) to fit ${Math.round(MAX_PAYLOAD_BYTES / 1024)}KB`
    )
  }

  if (history.length === 0 && trimSizeAfter > MAX_PAYLOAD_BYTES) {
    logger.warn(
      `[TRIM] current message alone is ~${Math.round(trimSizeAfter / 1024)}KB, over the ${Math.round(MAX_PAYLOAD_BYTES / 1024)}KB cap — the request will be rejected as too large`
    )
  }

  // After trimming, drop any current-message toolResults whose tool_use was
  // removed from history — sending a toolResult without a matching toolUse
  // in the surviving history causes Bedrock 400 ValidationException.
  if (uim?.userInputMessageContext?.toolResults) {
    const survivingToolUseIds = new Set<string>(
      history.flatMap(
        (h) => h.assistantResponseMessage?.toolUses?.map((tu: any) => tu.toolUseId) ?? []
      )
    )
    const filtered = uim.userInputMessageContext.toolResults.filter((tr: any) =>
      survivingToolUseIds.has(tr.toolUseId)
    )
    if (filtered.length === 0) {
      delete uim.userInputMessageContext.toolResults
      if (Object.keys(uim.userInputMessageContext).length === 0) {
        delete uim.userInputMessageContext
      }
    } else {
      uim.userInputMessageContext.toolResults = filtered
    }
  }

  // Image carry-forward: put an image back only where it went missing.
  //
  // OpenCode strips the bytes off earlier messages, so an image the user sent
  // ten turns ago can vanish from history entirely — and then the model is
  // asked about something it cannot see. The cache exists to restore that.
  //
  // What it must not do is repeat an image that history already carries. Doing
  // that attached a screenshot from turn 566 to every question for the next
  // 145 turns: 87KB on each request, and a model being shown a picture as
  // though it belonged to whatever was just asked.
  if (carryForward && uim) {
    const freshImages = (uim.images as KiroImage[] | undefined) ?? []
    const historyImages: KiroImage[] = []
    if (imageCache.hasEverHadImages(workspaceKey, fingerprint) || freshImages.length > 0) {
      for (const h of history) {
        const imgs = h.userInputMessage?.images as KiroImage[] | undefined
        if (imgs && imgs.length > 0) historyImages.push(...imgs)
      }
    }

    const known = [...freshImages, ...historyImages]
    if (known.length > 0) imageCache.upsert(workspaceKey, fingerprint, known)

    // History still holds them, or the user just attached one: nothing to do.
    if (freshImages.length === 0 && historyImages.length === 0) {
      const carried = imageCache.get(workspaceKey, fingerprint)
      if (carried && carried.length > 0) uim.images = carried.slice(0, MAX_KIRO_IMAGES)
    }
  }

  return {
    request,
    resolved,
    convId,
    agentContinuationId,
    fingerprint,
    toolNameMap: toolNameRegistry.toOriginalMap()
  }
}

/**
 * Bytes an object costs on the wire.
 *
 * Attachments are Uint8Arrays that the SDK base64-encodes, but JSON.stringify
 * renders them as {"0":137,"1":80,...} — about eight times their real size,
 * and a quarter second of CPU per megabyte. Measuring that way both
 * overstated the payload, so attachments were trimmed away as if they were
 * enormous, and made every request pay for the mismeasurement.
 */
function wireSize(value: any): number {
  let attachmentChars = 0
  const strip = (node: any): any => {
    if (!node || typeof node !== 'object') return node
    if (node instanceof Uint8Array) {
      attachmentChars += Math.ceil(node.byteLength / 3) * 4
      return ''
    }
    if (Array.isArray(node)) return node.map(strip)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node)) out[k] = strip(v)
    return out
  }

  return JSON.stringify(strip(value)).length + attachmentChars
}

export function transformToSdkRequest(
  body: any,
  model: string,
  auth: KiroAuthDetails,
  think = false,
  budget = 20000,
  showToast?: ToastFunction,
  workspace = '',
  carryForward = true,
  sessionId?: string,
  maxPayloadBytes = 5_000_000,
  thinkingDisabled = false,
  maxTokens?: number,
  requestedEffort?: Effort
): SdkPreparedRequest {
  const { request, resolved, convId, fingerprint, toolNameMap } = buildCodeWhispererRequest(
    body,
    model,
    auth,
    think,
    budget,
    showToast,
    workspace,
    carryForward,
    sessionId,
    maxPayloadBytes
  )

  // Resolve effort level based on config and model capabilities
  const effort = thinkingDisabled ? undefined : getEffectiveEffort(resolved, think, requestedEffort)
  const modelRequestFields = buildModelRequestFields(resolved, effort, thinkingDisabled, maxTokens)

  const region = extractRegionFromArn(auth.profileArn) ?? auth.region
  // resolveKiroEndpoint returns the full URL including /generateAssistantResponse.
  // Strip the path so the endpoint field holds only the base (what the SDK uses).
  const endpointFull = resolveKiroEndpoint(auth)
  const endpoint = endpointFull.replace(/\/generateAssistantResponse$/, '')
  const workspaceKey = sessionId ? `sess:${sessionId}` : workspace
  // Payload size is the strongest predictor of how long Kiro takes to answer —
  // 4s below 100k tokens, over a minute past 300k — so it belongs on trace
  // rather than behind an environment variable nobody remembers to set.
  // Measuring costs a fraction of a millisecond; debug() decides the rest.
  logger.debug(
    `[PAYLOAD] convId=${convId} ~${Math.round(wireSize(request.conversationState) / 1024)}KB` +
      ` history=${request.conversationState.history?.length ?? 0} entries`
  )
  return {
    conversationState: request.conversationState,
    profileArn: request.profileArn,
    streaming: true,
    effectiveModel: resolved,
    conversationId: convId,
    conversationKey: { workspace: workspaceKey, fingerprint },
    region,
    endpoint,
    toolNameMap,
    effort,
    modelRequestFields
  }
}
