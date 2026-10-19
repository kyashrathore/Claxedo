const CHUNK = 0x8000

export function encodeBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let start = 0; start < bytes.length; start += CHUNK) binary += String.fromCharCode(...bytes.subarray(start, start + CHUNK))
  return btoa(binary)
}

export function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}
