import type { TaskAttachmentRecord } from "./contracts"

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

/** The prompt part a runtime takes an image as. */
export function attachmentDataUrl(record: Pick<TaskAttachmentRecord, "mime" | "bytes">): string {
  return `data:${record.mime};base64,${encodeAttachmentData(record.bytes)}`
}
