import { describe, expect, test } from 'bun:test'
import {
  convertImagesToKiroFormat,
  MAX_KIRO_IMAGE_BYTES,
  MAX_KIRO_IMAGES
} from '../plugin/image-handler.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64')
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]).toString('base64')
const WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50
]).toString('base64')
const NOT_AN_IMAGE = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')

function image(mediaType: string, data: string) {
  return { mediaType, data }
}

describe('the format sent on the wire', () => {
  test('each of the four accepted formats survives', () => {
    const { images } = convertImagesToKiroFormat([
      image('image/png', PNG),
      image('image/jpeg', JPEG),
      image('image/gif', GIF),
      image('image/webp', WEBP)
    ])

    expect(images.map((i) => i.format)).toEqual(['png', 'jpeg', 'gif', 'webp'])
  })

  test('image/jpg becomes jpeg', () => {
    // Not a real media type, but widely emitted; "jpg" is not in the enum.
    const { images } = convertImagesToKiroFormat([image('image/jpg', JPEG)])
    expect(images[0]!.format).toBe('jpeg')
  })

  test('casing and parameters do not leak into the format', () => {
    const { images } = convertImagesToKiroFormat([image('IMAGE/PNG;charset=binary', PNG)])
    expect(images[0]!.format).toBe('png')
  })

  test('the bytes outrank a wrong label', () => {
    // A mismatch between declared format and actual bytes fails the whole
    // request, so a mislabelled image is corrected rather than passed on.
    const { images } = convertImagesToKiroFormat([image('image/png', JPEG)])
    expect(images[0]!.format).toBe('jpeg')
  })

  test('an unsupported format is dropped, not sent as-is', () => {
    const { images, omitted } = convertImagesToKiroFormat([
      image('image/svg+xml', NOT_AN_IMAGE),
      image('image/png', PNG)
    ])

    expect(images).toHaveLength(1)
    expect(images[0]!.format).toBe('png')
    expect(omitted).toBe(1)
  })
})

describe('the budget', () => {
  test('is counted in decoded bytes, not base64 characters', () => {
    // Base64 is 4/3 the size of the bytes it encodes; measuring the string
    // made the cap a third tighter than the service's.
    const bytes = new Uint8Array(MAX_KIRO_IMAGE_BYTES - 1024)
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const big = Buffer.from(bytes).toString('base64')
    expect(big.length).toBeGreaterThan(MAX_KIRO_IMAGE_BYTES)

    const { images } = convertImagesToKiroFormat([image('image/png', big)])
    expect(images).toHaveLength(1)
  })

  test('stops once the byte budget is spent', () => {
    const half = new Uint8Array(Math.floor(MAX_KIRO_IMAGE_BYTES * 0.6))
    half.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const b64 = Buffer.from(half).toString('base64')

    const { images, omitted } = convertImagesToKiroFormat([
      image('image/png', b64),
      image('image/png', b64)
    ])

    expect(images).toHaveLength(1)
    expect(omitted).toBe(1)
  })

  test('never sends more images than the service accepts', () => {
    const many = Array.from({ length: MAX_KIRO_IMAGES + 3 }, () => image('image/png', PNG))
    const { images, omitted } = convertImagesToKiroFormat(many)

    expect(images).toHaveLength(MAX_KIRO_IMAGES)
    expect(omitted).toBe(3)
  })
})

describe('an image stays visible for the rest of the conversation', () => {
  const auth: any = {
    access: 'a',
    refresh: 'r',
    expires: 0,
    authMethod: 'idc',
    region: 'us-east-1'
  }
  const attachment = { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }

  async function currentTurnImages(messages: any[], sessionId: string): Promise<number> {
    const { transformToSdkRequest } = await import('../plugin/request.js')
    const result = transformToSdkRequest(
      { messages },
      'auto',
      auth,
      false,
      0,
      undefined,
      '/ws-carry',
      true,
      sessionId
    )
    const current = (result.conversationState as any).currentMessage.userInputMessage
    return (current.images ?? []).length
  }

  test('a later question repeats the image, even when history still holds it', async () => {
    // The model reads what is on the current message; an image left only in
    // history reached it as nothing, and it went hunting for the file on disk.
    const session = `ses_carry_kept_${Date.now()}`
    const first = [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, attachment] }]
    expect(await currentTurnImages(first, session)).toBe(1)

    expect(
      await currentTurnImages(
        [
          ...first,
          { role: 'assistant', content: [{ type: 'text', text: 'A screenshot.' }] },
          { role: 'user', content: [{ type: 'text', text: 'what is the last green word?' }] }
        ],
        session
      )
    ).toBe(1)
  })

  test('and when OpenCode has stripped the bytes off the earlier turn', async () => {
    const session = `ses_carry_stripped_${Date.now()}`
    await currentTurnImages(
      [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, attachment] }],
      session
    )

    expect(
      await currentTurnImages(
        [
          { role: 'user', content: [{ type: 'text', text: 'what is this?' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'A screenshot.' }] },
          { role: 'user', content: [{ type: 'text', text: 'what is the last green word?' }] }
        ],
        session
      )
    ).toBe(1)
  })
})
