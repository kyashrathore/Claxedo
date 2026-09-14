/**
 * RFC 4648 s5 base64url, unpadded. `btoa` is the only host API used — no
 * `Buffer` — so the same function runs on Node, Bun, Electron main and
 * renderer, browsers and workerd, and its output is byte-identical to Node's
 * `toString("base64url")` (which the CLI signs with and the D1 authority
 * decodes with `atob`).
 *
 * NOT `Uint8Array.prototype.toBase64`, which produces identical output and would
 * replace the loop: claxedo-server declares `node: ">=22 <25"` and that method
 * only landed in 22.13, so the declared floor still permits a runtime without it.
 */
export function base64UrlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ""
  // A for..of loop rather than a spread: a spread blows the argument count on
  // large inputs.
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/**
 * The inverse. The alphabet is checked BEFORE decoding and an empty string is
 * rejected, so a caller cannot mistake "decoded nothing" for "decoded to no
 * bytes"; standard base64 is rejected too, because a `+` or `/` reaching a
 * base64url reader means the value came from somewhere it should not have.
 *
 * `error` is supplied by the caller so each authority keeps its own taxonomy.
 * A bad alphabet and a throw from `atob` raise the same error: no caller has
 * anything different to do about them.
 */
export function base64UrlDecode(
  value: string,
  options?: { error?: (message: string) => Error },
): Uint8Array {
  const fail = options?.error ?? ((message: string) => new Error(message))
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw fail("value is not base64url")
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    throw fail("value is not base64url")
  }
}

/**
 * Content-timing-independent string equality. No early return on length
 * mismatch: the accumulator is seeded with the length XOR and the loop runs the
 * LONGER length, so total time depends only on that length and never on where
 * the inputs first differ. Out-of-range `charCodeAt` is NaN and `NaN | 0` is 0,
 * so the pad is well defined.
 *
 * Pure ECMAScript — no node:crypto, no Buffer, no TextEncoder — and injective
 * over all JavaScript strings, including unpaired surrogates.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    diff |= (a.charCodeAt(index) | 0) ^ (b.charCodeAt(index) | 0)
  }
  return diff === 0
}

/**
 * `${prefix}_${32 lowercase hex}` — 128 bits, no timestamp, no ordering.
 *
 * Global Web Crypto, never `node:crypto` and never `Buffer`: getRandomValues is
 * available in browsers, the Electron renderer, Node >= 19 and workerd, and
 * unlike `crypto.randomUUID()` it is not [SecureContext]-gated, so one helper
 * covers every runtime the callers span. The underscore separator and hex
 * alphabet keep the result legal for the control plane's inbound identifier
 * regex, and for URL, DNS-label, relay-room and storage-key use.
 */
export function prefixedRandomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let hex = ""
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0")
  return `${prefix}_${hex}`
}

/**
 * SHA-256 of a string, as 64 lowercase hex characters.
 *
 * Global Web Crypto for the same reason as `prefixedRandomId`, and a hex loop
 * rather than `toHex()`: claxedo-server declares `node: ">=22 <25"` and that
 * method landed in 24.
 */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  let hex = ""
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0")
  return hex
}
