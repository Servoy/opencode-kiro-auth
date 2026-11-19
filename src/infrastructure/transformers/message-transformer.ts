export function findOriginalToolCall(msgs: any[], toolUseId: string): any | null {
  for (const m of msgs) {
    if (m.role === 'assistant') {
      if (m.tool_calls) {
        for (const tc of m.tool_calls) if (tc.id === toolUseId) return tc
      }
      if (Array.isArray(m.content)) {
        for (const p of m.content) if (p.type === 'tool_use' && p.id === toolUseId) return p
      }
    }
  }
  return null
}

/**
 * A message whose own arrays are safe to merge into.
 *
 * `{ ...m }` shares `content` and `tool_calls` with the caller, so the merge
 * below pushed straight into the message OpenCode handed us. The request loop
 * re-prepares the same body on every retry, switch and fallback, so each of
 * those appended the next message's parts again: one attachment arrived twice,
 * then three times, and the history Kiro was sent stopped matching the one it
 * had already been sent — which is also the prefix it prices at half.
 */
function detachArrays(m: any): any {
  const copy = { ...m }
  if (Array.isArray(m.content)) copy.content = [...m.content]
  if (Array.isArray(m.tool_calls)) copy.tool_calls = [...m.tool_calls]
  return copy
}

/**
 * Join runs of same-role messages into one, without touching the input.
 *
 * Kiro's history has to alternate, so two user messages in a row — a tool
 * result followed by what the user typed next — become one entry.
 */
export function mergeAdjacentMessages(msgs: any[]): any[] {
  const merged: any[] = []
  for (const m of msgs) {
    if (!merged.length) merged.push(detachArrays(m))
    else {
      const last = merged[merged.length - 1]
      if (last && m.role === last.role) {
        if (Array.isArray(last.content) && Array.isArray(m.content)) last.content.push(...m.content)
        else if (typeof last.content === 'string' && typeof m.content === 'string')
          last.content += '\n' + m.content
        else if (Array.isArray(last.content) && typeof m.content === 'string')
          last.content.push({ type: 'text', text: m.content })
        else if (typeof last.content === 'string' && Array.isArray(m.content))
          last.content = [{ type: 'text', text: last.content }, ...m.content]
        if (m.tool_calls) {
          if (!last.tool_calls) last.tool_calls = []
          last.tool_calls.push(...m.tool_calls)
        }
        if (m.role === 'tool') {
          if (!last.tool_results)
            last.tool_results = [{ content: last.content, tool_call_id: last.tool_call_id }]
          last.tool_results.push({ content: m.content, tool_call_id: m.tool_call_id })
        }
      } else merged.push(detachArrays(m))
    }
  }
  return merged
}

export function getContentText(m: any): string {
  if (!m) return ''
  if (typeof m === 'string') return m
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content))
    return m.content
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text || '')
      .join('')
  return m.text || ''
}
