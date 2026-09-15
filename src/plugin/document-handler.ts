import { Buffer } from 'node:buffer'

/** Kiro reads up to five documents per message (Kiro IDE 0.11 release note). */
export const MAX_KIRO_DOCUMENTS = 5

/** Formats DocumentBlock accepts; anything else is rejected by the service. */
const KIRO_DOCUMENT_FORMATS: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/html': 'html',
  'text/markdown': 'md',
  'text/x-markdown': 'md',
  'text/plain': 'txt',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx'
}

export interface KiroDocument {
  name: string
  format: string
  source: {
    bytes: Uint8Array
  }
}

interface UnifiedDocument {
  mediaType: string
  filename: string
  data: string
}

interface DocumentConversionResult {
  documents: KiroDocument[]
  omitted: number
}

function base64ToUint8Array(b64: string): Uint8Array {
  const buf = Buffer.from(b64, 'base64')
  const out = new Uint8Array(buf.byteLength)
  out.set(buf)
  return out
}

/** Split a `data:<mediaType>;base64,<payload>` URL, or return null. */
function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  if (!url.startsWith('data:')) return null
  const comma = url.indexOf(',')
  if (comma < 0) return null
  const data = url.slice(comma + 1)
  if (!data) return null
  const semi = url.indexOf(';', 5)
  const mediaType = semi > 0 && semi < comma ? url.slice(5, semi) : url.slice(5, comma)
  return { mediaType, data }
}

/**
 * Collect document attachments from a message's content parts.
 *
 * OpenCode delivers them as OpenAI file parts —
 * `{type:'file', file:{filename, file_data:'data:...;base64,...'}}` — and the
 * Anthropic `{type:'document', source:{...}}` shape is accepted too so the
 * extractor does not depend on which conversion the host picked.
 */
export function extractAllDocuments(content: any): UnifiedDocument[] {
  if (!Array.isArray(content)) return []

  const documents: UnifiedDocument[] = []

  for (const item of content) {
    if (item?.type === 'file') {
      const url = item.file?.file_data ?? item.url
      const parsed = typeof url === 'string' ? parseDataUrl(url) : null
      if (!parsed) continue
      documents.push({
        mediaType: item.mime || parsed.mediaType,
        filename: item.file?.filename || item.filename || '',
        data: parsed.data
      })
    } else if (item?.type === 'document' && item.source?.type === 'base64' && item.source.data) {
      documents.push({
        mediaType: item.source.media_type || '',
        filename: item.title || item.name || '',
        data: item.source.data
      })
    }
  }

  return documents
}

/** Canonical DocumentFormat for a media type, or undefined when unsupported. */
function formatFromMediaType(mediaType: string): string | undefined {
  return KIRO_DOCUMENT_FORMATS[mediaType.split(';')[0]?.trim().toLowerCase() ?? '']
}

/**
 * Build a name the service will accept and that is unique in this request.
 *
 * Verbatim from the service: "Names must be 1-200 characters containing only
 * alphanumeric characters, whitespace, hyphens, underscores, parentheses, or
 * square brackets, with no consecutive whitespace." A period is not on that
 * list, so the extension has to go. Duplicates fail the whole request, and the
 * same file attached twice in one conversation is ordinary, so collisions get
 * a numeric suffix.
 */
function uniqueName(filename: string, taken: Set<string>): string {
  const base =
    filename
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9\s\-_()[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 190) || 'document'

  let name = base
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (${n})`
  taken.add(name.toLowerCase())
  return name
}

/**
 * Convert documents to the wire shape, dropping what the service would reject.
 *
 * Unsupported media types are skipped rather than sent with a format that is
 * not in the enum, and no more than MAX_KIRO_DOCUMENTS are attached.
 */
export function convertDocumentsToKiroFormat(
  documents: UnifiedDocument[]
): DocumentConversionResult {
  const converted: KiroDocument[] = []
  const taken = new Set<string>()

  for (const doc of documents) {
    if (converted.length >= MAX_KIRO_DOCUMENTS) break

    const format = formatFromMediaType(doc.mediaType)
    if (!format) continue

    converted.push({
      name: uniqueName(doc.filename, taken),
      format,
      source: { bytes: base64ToUint8Array(doc.data) }
    })
  }

  return { documents: converted, omitted: documents.length - converted.length }
}
