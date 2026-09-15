import { Buffer } from 'node:buffer'

interface UnifiedImage {
  mediaType: string
  data: string
}

export const MAX_KIRO_IMAGES = 4
/** Decoded image bytes, matching how image-cache measures the same budget. */
export const MAX_KIRO_IMAGE_BYTES = 3_750_000

/** The only formats ImageBlock accepts; anything else is rejected outright. */
const KIRO_IMAGE_FORMATS = new Set(['gif', 'jpeg', 'png', 'webp'])

/**
 * Canonical format for a media type, or undefined when unsupported.
 *
 * Handles the spellings that reach us in practice: `image/jpg` is not a real
 * media type but is emitted widely, parameters like `;charset=` ride along on
 * data URLs, and casing varies.
 */
function formatFromMediaType(mediaType: string): string | undefined {
  const subtype = mediaType.split(';')[0]?.trim().toLowerCase().split('/')[1]
  if (!subtype) return undefined
  const canonical = subtype === 'jpg' ? 'jpeg' : subtype
  return KIRO_IMAGE_FORMATS.has(canonical) ? canonical : undefined
}

/**
 * Format read from the image's own magic bytes.
 *
 * The service rejects a request outright when the declared format and the
 * actual bytes disagree, so the bytes win over whatever the caller labelled it.
 */
function formatFromBytes(b: Uint8Array): string | undefined {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif'
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return 'webp'
  return undefined
}

export interface KiroImage {
  format: string
  source: {
    bytes: Uint8Array
  }
}

interface ImageConversionResult {
  images: KiroImage[]
  omitted: number
}

/** Decode base64 to a plain Uint8Array. Uses Node Buffer when available (native
 *  C++, ~10x faster than the atob + charCodeAt loop) and falls back to atob
 *  in non-Node environments. Returns a fresh Uint8Array — Buffer's underlying
 *  ArrayBuffer is shared with Node's pool, so we copy to detach. */
function base64ToUint8Array(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(b64, 'base64')
    const out = new Uint8Array(buf.byteLength)
    out.set(buf)
    return out
  }
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

export function extractAllImages(content: any): UnifiedImage[] {
  if (!Array.isArray(content)) return []

  const images: UnifiedImage[] = []

  for (const item of content) {
    if (item.type === 'image' && item.source?.type === 'base64') {
      images.push({
        mediaType: item.source.media_type || 'image/jpeg',
        data: item.source.data
      })
    } else if (item.type === 'image_url' && item.image_url?.url) {
      const url = item.image_url.url
      if (!url.startsWith('data:')) continue

      const comma = url.indexOf(',')
      if (comma < 0) continue

      const data = url.slice(comma + 1)
      if (!data) continue

      const headerEnd = url.indexOf(';', 5)
      const mediaType = headerEnd > 0 ? url.slice(5, headerEnd) : url.slice(5, comma)

      images.push({
        mediaType: mediaType || 'image/jpeg',
        data
      })
    }
  }

  return images
}

/**
 * Convert images to the wire shape, dropping what the service would reject.
 *
 * An image is skipped when its format is not one of the four ImageBlock
 * accepts, and the budget is counted in decoded bytes — measuring base64
 * characters made the cap a third tighter than intended.
 */
export function convertImagesToKiroFormat(images: UnifiedImage[]): ImageConversionResult {
  const converted: KiroImage[] = []
  let totalBytes = 0

  for (const img of images) {
    if (converted.length >= MAX_KIRO_IMAGES) break

    const bytes = base64ToUint8Array(img.data)
    const format = formatFromBytes(bytes) ?? formatFromMediaType(img.mediaType)
    if (!format) continue

    if (totalBytes + bytes.byteLength > MAX_KIRO_IMAGE_BYTES) break

    converted.push({ format, source: { bytes } })
    totalBytes += bytes.byteLength
  }

  return { images: converted, omitted: images.length - converted.length }
}

export function extractTextFromParts(parts: any[]): string {
  const textParts: string[] = []

  for (const part of parts) {
    if (part.text && typeof part.text === 'string') {
      textParts.push(part.text)
    } else if (part.type === 'text' && part.text) {
      textParts.push(part.text)
    }
  }

  return textParts.join('')
}
