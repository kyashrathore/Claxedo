import type { TaskAttachmentMime, TaskAttachmentRecord } from "./contracts"

/**
 * RFC 4648 s4 base64, padded: what a `data:` URL carries and what `btoa`
 * produces. `@claxedo/helpers` deliberately offers only the url-safe alphabet
 * and refuses this one, and `Buffer` is absent on workerd, so the codec is
 * written on `atob`/`btoa` here.
 */

export function encodeAttachmentData(bytes: Uint8Array): string {
  let binary = ""
  // A for..of loop rather than a spread: a spread blows the argument count on
  // an image-sized input.
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** The bytes, or undefined for anything that is not padded standard base64 — never a partial decode. */
export function decodeAttachmentData(value: string): Uint8Array | undefined {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
  } catch {
    return undefined
  }
}

/** How many bytes a base64 string decodes to, from its length alone: read before the decode so a refusal costs nothing. */
export function decodedByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return (value.length / 4) * 3 - padding
}

function hasSignature(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte)
}

/**
 * The image the bytes actually are, read from their signature: PNG's eight
 * magic bytes, JPEG's `FF D8 FF`, the two GIF89a-era headers, and WebP's
 * `RIFF`/`WEBP` pair. A declared mime is a claim; the bytes are what a browser
 * or a harness opens, so data matching no allowed signature is not an image
 * this kit will store or serve.
 */
export function sniffedAttachmentMime(bytes: Uint8Array): TaskAttachmentMime | undefined {
  if (hasSignature(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (hasSignature(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (
    hasSignature(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    hasSignature(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return "image/gif"
  }
  if (hasSignature(bytes, [0x52, 0x49, 0x46, 0x46]) && hasSignature(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp"
  }
  return undefined
}

/** The prompt part a runtime takes an image as. */
export function attachmentDataUrl(record: Pick<TaskAttachmentRecord, "mime" | "bytes">): string {
  return `data:${record.mime};base64,${encodeAttachmentData(record.bytes)}`
}
