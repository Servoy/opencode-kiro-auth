import * as crypto from 'crypto'

const MAX_TOOL_NAME_LENGTH = 64

export function shortenToolName(name: string): string {
  if (!name || name.length <= MAX_TOOL_NAME_LENGTH) return name
  const hash = crypto.createHash('sha256').update(name).digest('hex').slice(0, 12)
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`
}

export function buildToolNameMaps(tools: any[]): {
  toKiroName: (name: string) => string
  fromKiroName: (name: string) => string
} {
  const originalToAlias = new Map<string, string>()
  const aliasToOriginal = new Map<string, string>()

  for (const t of tools) {
    const name = t.name || t.function?.name
    if (!name) continue
    const alias = shortenToolName(name)
    originalToAlias.set(name, alias)
    if (alias !== name) aliasToOriginal.set(alias, name)
  }

  return {
    toKiroName: (name: string) => originalToAlias.get(name) || shortenToolName(name),
    fromKiroName: (name: string) => aliasToOriginal.get(name) || name
  }
}

function sanitizeToolInput(input: any): any {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const result: Record<string, any> = {}
  for (const [key, value] of Object.entries(input)) {
    if (key === '') continue
    result[key] = value
  }
  return result
}

export function convertToolsToCodeWhisperer(tools: any[]): any[] {
  return tools.map((t) => ({
    toolSpecification: {
      name: shortenToolName(t.name || t.function?.name || ''),
      description: (t.description || t.function?.description || '').substring(0, 9216),
      inputSchema: { json: sanitizeToolInput(t.input_schema || t.function?.parameters || {}) }
    }
  }))
}

export function deduplicateToolResults(trs: any[]): any[] {
  const u: any[] = [],
    s = new Set()
  for (const t of trs) {
    if (!s.has(t.toolUseId)) {
      s.add(t.toolUseId)
      u.push(t)
    }
  }
  return u
}

export function deduplicateToolCallsByContent(toolCalls: any[]): any[] {
  const seen = new Set<string>()
  const unique: any[] = []
  for (const tc of toolCalls) {
    const key = `${tc.name || tc.function?.name}-${tc.input || tc.function?.arguments}`
    if (!seen.has(key)) {
      seen.add(key)
      unique.push(tc)
    }
  }
  return unique
}
