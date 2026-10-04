/**
 * Web Crypto helpers shared by the JWKS endpoint and the token signers.
 *
 * These use the global `crypto` (Web Crypto) object, which is available both in
 * Node.js (>= 19, global `crypto.subtle` / `crypto.randomUUID`) and in
 * Cloudflare Workers. Keeping the control-plane token/JWKS path on Web Crypto
 * means the hosted Worker bundle never pulls in `node:crypto`, while the local
 * Node server keeps working unchanged.
 */

const encoder = new TextEncoder()

/**
 * SHA-256 of `material`, hex-encoded and sliced to the first 16 hex chars
 * (8 bytes). Used to derive a stable `kid` from public key material so the JWKS
 * endpoint and the mint signer agree by construction.
 */
export async function sha256Hex16(material: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(material))
  let hex = ""
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0")
  }
  return hex.slice(0, 16)
}

/** RFC 4122 v4 UUID via Web Crypto (`crypto.randomUUID`). */
export function randomToken(): string {
  return crypto.randomUUID()
}

/**
 * Constant-time string equality for bearer-token comparison.
 *
 * Avoids `node:crypto.timingSafeEqual` so it stays in the Worker bundle; the
 * comparison touches every byte of both inputs regardless of where they first
 * differ, so the timing does not leak the matching prefix length.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBytes = encoder.encode(a)
  const bBytes = encoder.encode(b)
  let diff = aBytes.length ^ bBytes.length
  const length = Math.max(aBytes.length, bBytes.length)
  for (let i = 0; i < length; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0)
  }
  return diff === 0
}
