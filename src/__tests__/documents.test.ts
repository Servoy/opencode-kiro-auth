import { describe, expect, test } from 'bun:test'
import {
  convertDocumentsToKiroFormat,
  extractAllDocuments,
  MAX_KIRO_DOCUMENTS
} from '../plugin/document-handler.js'

const PDF = Buffer.from('%PDF-1.4 hello').toString('base64')

/** The shape OpenCode delivers, via the AI SDK's OpenAI conversion. */
function filePart(filename: string, mediaType = 'application/pdf', data = PDF) {
  return { type: 'file', file: { filename, file_data: `data:${mediaType};base64,${data}` } }
}

describe('finding documents in a message', () => {
  test('reads an OpenAI file part', () => {
    const docs = extractAllDocuments([
      { type: 'text', text: 'what is this?' },
      filePart('spec.pdf')
    ])

    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({ mediaType: 'application/pdf', filename: 'spec.pdf' })
  })

  test('reads the Anthropic document shape too', () => {
    const docs = extractAllDocuments([
      {
        type: 'document',
        title: 'spec.pdf',
        source: { type: 'base64', media_type: 'application/pdf', data: PDF }
      }
    ])

    expect(docs).toHaveLength(1)
    expect(docs[0]!.mediaType).toBe('application/pdf')
  })

  test('ignores images and plain text', () => {
    expect(
      extractAllDocuments([
        { type: 'text', text: 'hi' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }
      ])
    ).toHaveLength(0)
  })
})

describe('putting documents on the wire', () => {
  test('maps each accepted media type to its format', () => {
    const cases: Array<[string, string]> = [
      ['application/pdf', 'pdf'],
      ['text/csv', 'csv'],
      ['application/msword', 'doc'],
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
      ['text/html', 'html'],
      ['text/markdown', 'md'],
      ['text/plain', 'txt'],
      ['application/vnd.ms-excel', 'xls'],
      ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx']
    ]

    for (const [mediaType, format] of cases) {
      const { documents } = convertDocumentsToKiroFormat(
        extractAllDocuments([filePart(`file.${format}`, mediaType)])
      )
      expect(documents[0]!.format).toBe(format)
    }
  })

  test('drops a media type the service does not accept', () => {
    const { documents, omitted } = convertDocumentsToKiroFormat(
      extractAllDocuments([filePart('archive.zip', 'application/zip')])
    )

    expect(documents).toHaveLength(0)
    expect(omitted).toBe(1)
  })

  test('the same file twice gets distinct names', () => {
    // Duplicate names fail the whole request, and attaching a file twice in
    // one conversation is ordinary.
    const { documents } = convertDocumentsToKiroFormat(
      extractAllDocuments([filePart('leave.pdf'), filePart('leave.pdf')])
    )

    expect(documents).toHaveLength(2)
    expect(documents[0]!.name).not.toBe(documents[1]!.name)
  })

  test('a name obeys the character rule the service states', () => {
    // "1-200 characters containing only alphanumeric characters, whitespace,
    // hyphens, underscores, parentheses, or square brackets, with no
    // consecutive whitespace" — a period is not on that list, so no extension.
    const { documents } = convertDocumentsToKiroFormat(
      extractAllDocuments([filePart('Invoice #12/2026 (final)_v2.pdf')])
    )

    expect(documents[0]!.name).toBe('Invoice 12 2026 (final)_v2')
    expect(documents[0]!.name).toMatch(/^[a-zA-Z0-9 \-_()[\]]{1,200}$/)
    expect(documents[0]!.name).not.toMatch(/\s\s/)
  })

  test('an over-long name is cut to the allowed length', () => {
    const { documents } = convertDocumentsToKiroFormat(
      extractAllDocuments([filePart(`${'a'.repeat(400)}.pdf`)])
    )

    expect(documents[0]!.name.length).toBeLessThanOrEqual(200)
  })

  test('never sends more than the service reads', () => {
    const many = Array.from({ length: MAX_KIRO_DOCUMENTS + 2 }, (_, i) => filePart(`d${i}.pdf`))
    const { documents, omitted } = convertDocumentsToKiroFormat(extractAllDocuments(many))

    expect(documents).toHaveLength(MAX_KIRO_DOCUMENTS)
    expect(omitted).toBe(2)
  })

  test('carries the decoded bytes, not base64', () => {
    const { documents } = convertDocumentsToKiroFormat(extractAllDocuments([filePart('a.pdf')]))

    expect(documents[0]!.source.bytes).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(documents[0]!.source.bytes).toString()).toBe('%PDF-1.4 hello')
  })
})

describe('a document survives into the next turn', () => {
  const auth: any = {
    access: 'a',
    refresh: 'r',
    expires: 0,
    authMethod: 'idc',
    region: 'us-east-1'
  }

  test('history carries the document, so a follow-up question still sees it', async () => {
    // The document rides on the turn it arrived on. Without it in history, a
    // second question about the same PDF reached the model with nothing
    // attached and no record of it ever having been sent.
    const { transformToSdkRequest } = await import('../plugin/request.js')

    const result = transformToSdkRequest(
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'what is this?' }, filePart('spec.pdf')]
          },
          { role: 'assistant', content: [{ type: 'text', text: 'An invoice.' }] },
          { role: 'user', content: [{ type: 'text', text: 'what is the total?' }] }
        ]
      },
      'auto',
      auth,
      false,
      0,
      undefined,
      '/ws-doc-history',
      true,
      'ses_doc_history'
    )

    const history = (result.conversationState as any).history ?? []
    const withDocs = history.filter((h: any) => (h.userInputMessage?.documents ?? []).length > 0)

    expect(withDocs).toHaveLength(1)
    expect(withDocs[0].userInputMessage.documents[0].format).toBe('pdf')
  })
})

describe('a document survives a long conversation', () => {
  const auth: any = {
    access: 'a',
    refresh: 'r',
    expires: 0,
    authMethod: 'idc',
    region: 'us-east-1'
  }

  test('ten more turns of chatter do not trim the attachment away', async () => {
    const { transformToSdkRequest } = await import('../plugin/request.js')

    const messages: any[] = [
      { role: 'user', content: [{ type: 'text', text: 'what is this?' }, filePart('invoice.pdf')] },
      { role: 'assistant', content: [{ type: 'text', text: 'An invoice.' }] }
    ]
    // Enough bulk that trimming has to happen.
    for (let i = 0; i < 10; i++) {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: `q${i} ` + 'x'.repeat(40_000) }]
      })
      messages.push({ role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(40_000) }] })
    }
    messages.push({ role: 'user', content: [{ type: 'text', text: 'what is the total?' }] })

    const result = transformToSdkRequest(
      { messages },
      'auto',
      auth,
      false,
      0,
      undefined,
      '/ws-doc-long',
      true,
      'ses_doc_long',
      300_000
    )

    const history = (result.conversationState as any).history ?? []
    const docs = history.flatMap((h: any) => h.userInputMessage?.documents ?? [])

    expect(JSON.stringify(result.conversationState).length).toBeLessThanOrEqual(300_000)
    expect(docs).toHaveLength(1)
    expect(docs[0].format).toBe('pdf')
  })
})

describe('an attachment that cannot fit', () => {
  const auth: any = {
    access: 'a',
    refresh: 'r',
    expires: 0,
    authMethod: 'idc',
    region: 'us-east-1'
  }

  test('says so instead of answering about a file it never sent', async () => {
    const { transformToSdkRequest } = await import('../plugin/request.js')

    const huge = Buffer.from('%PDF-1.4 ' + 'x'.repeat(400_000)).toString('base64')
    const messages: any[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'read this' },
          filePart('huge.pdf', 'application/pdf', huge)
        ]
      },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'text', text: 'and?' }] }
    ]

    const result = transformToSdkRequest(
      { messages },
      'auto',
      auth,
      false,
      0,
      undefined,
      '/ws-too-big',
      true,
      'ses_too_big',
      // Smaller than the attachment, so it cannot be kept.
      120_000
    )

    const content = (result.conversationState as any).currentMessage.userInputMessage.content
    expect(content).toMatch(/attachment\(s\) dropped/)
  })
})
