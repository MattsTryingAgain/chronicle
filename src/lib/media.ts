/**
 * media.ts — client-side image processing for Chronicle Media Phase 1.
 *
 * Provides resizing, base64 encoding, and size validation for profile
 * pictures before they are embedded in kind 30095 avatar events.
 *
 * All operations run in the browser (Canvas API). No server uploads needed
 * for phase 1 — images travel inside Nostr events as data URLs.
 */

export const AVATAR_MAX_PX = 512      // max dimension (width or height) in pixels
export const AVATAR_MAX_BYTES = 200 * 1024  // 200 KB limit on base64 payload

export interface ProcessedImage {
  dataUrl: string
  mimeType: 'image/jpeg' | 'image/png'
  size: number  // bytes of the base64 payload
  width: number
  height: number
}

/**
 * Load a File, resize it to fit within AVATAR_MAX_PX, encode as JPEG (or PNG
 * if the source is PNG with transparency), and validate against AVATAR_MAX_BYTES.
 *
 * Throws if the result is still over the size limit after JPEG compression.
 */
export async function processAvatarImage(file: File): Promise<ProcessedImage> {
  if (!file.type.startsWith('image/')) {
    throw new Error(`Unsupported file type: ${file.type}. Please use JPEG or PNG.`)
  }

  const bitmap = await createImageBitmap(file)
  const { width: origW, height: origH } = bitmap

  // Compute new dimensions maintaining aspect ratio
  let newW = origW
  let newH = origH
  if (origW > AVATAR_MAX_PX || origH > AVATAR_MAX_PX) {
    const scale = AVATAR_MAX_PX / Math.max(origW, origH)
    newW = Math.round(origW * scale)
    newH = Math.round(origH * scale)
  }

  const canvas = document.createElement('canvas')
  canvas.width = newW
  canvas.height = newH
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0, newW, newH)
  bitmap.close()

  // Use JPEG for photos, PNG only for images with transparency
  const isPng = file.type === 'image/png'
  const mimeType: 'image/jpeg' | 'image/png' = isPng ? 'image/png' : 'image/jpeg'

  // For JPEG, start at quality 0.85 and reduce if still over limit
  let dataUrl: string
  if (mimeType === 'image/jpeg') {
    dataUrl = canvas.toDataURL('image/jpeg', 0.85)
    const size = estimateBase64Size(dataUrl)
    if (size > AVATAR_MAX_BYTES) {
      // Retry at lower quality
      dataUrl = canvas.toDataURL('image/jpeg', 0.65)
      const size2 = estimateBase64Size(dataUrl)
      if (size2 > AVATAR_MAX_BYTES) {
        throw new Error(
          `Image is too large (${Math.round(size2 / 1024)} KB) even after compression. ` +
          `Please use a smaller image (max ${AVATAR_MAX_BYTES / 1024} KB).`,
        )
      }
    }
  } else {
    dataUrl = canvas.toDataURL('image/png')
    const size = estimateBase64Size(dataUrl)
    if (size > AVATAR_MAX_BYTES) {
      throw new Error(
        `PNG image is too large (${Math.round(size / 1024)} KB). ` +
        `Please use a JPEG or a smaller image (max ${AVATAR_MAX_BYTES / 1024} KB).`,
      )
    }
  }

  const size = estimateBase64Size(dataUrl)
  return { dataUrl, mimeType, size, width: newW, height: newH }
}

/**
 * Estimate the byte size of the base64 payload portion of a data URL.
 * (The actual binary size; excludes the "data:image/jpeg;base64," prefix.)
 */
export function estimateBase64Size(dataUrl: string): number {
  const base64 = dataUrl.split(',')[1] ?? ''
  // base64: 4 chars encode 3 bytes; padding '=' chars represent 0 bytes
  const padding = (base64.match(/=+$/) ?? [''])[0].length
  return (base64.length * 3) / 4 - padding
}
