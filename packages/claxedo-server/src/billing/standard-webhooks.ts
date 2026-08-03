/**
 * Standard Webhooks signature verification, hand-rolled on Web Crypto.
 *
 * Polar signs webhook deliveries per the Standard Webhooks spec
 * (https://polar.sh/docs/integrate/webhooks/delivery →
 * https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md):
 * - headers `webhook-id`, `webhook-timestamp` (unix seconds), and
 *   `webhook-signature` (space-delimited `v1,<base64>` entries);
 * - signed content is `${id}.${timestamp}.${body}`, HMAC-SHA256;
 * - timestamp tolerance ±5 minutes (the reference library's constant).
 *
 * Hand-rolled ON PURPOSE: `@polar-sh/sdk`'s `validateEvent` delegates to the
 * `standardwebhooks` npm package, which uses Node `Buffer`/crypto idioms — the
 * Worker import-graph guard (worker.import-graph.test.ts) bans `node:crypto`,
 * so this module implements the same scheme on `globalThis.crypto.subtle`.
 *
 * Secret handling matches BOTH conventions:
 * - Polar's SDK treats the dashboard secret as raw UTF-8 key material
 *   (`validateEvent` base64-encodes it and `standardwebhooks` decodes it back);
 * - a spec-style `whsec_<base64>` secret is base64-decoded.
 * PENDING: confirm against the Polar sandbox that dashboard secrets carry
 * no `whsec_` prefix; either way both branches verify correctly here.
 */

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WebhookSignatureError"
  }
}

const TOLERANCE_SECONDS = 5 * 60

function keyBytes(secret: string): Uint8Array {
  if (secret.startsWith("whsec_")) {
    const raw = atob(secret.slice("whsec_".length))
    return Uint8Array.from(raw, (c) => c.charCodeAt(0))
  }
  return new TextEncoder().encode(secret)
}

function base64(bytes: ArrayBuffer): string {
  let binary = ""
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Constant-time string comparison (both sides are base64 of fixed-size MACs). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return mismatch === 0
}

export type StandardWebhookHeaders = {
  "webhook-id"?: string | null
  "webhook-timestamp"?: string | null
  "webhook-signature"?: string | null
}

/**
 * Verify a Standard Webhooks delivery. Throws WebhookSignatureError on any
 * failure (missing headers, stale/future timestamp, no matching v1 signature).
 */
export async function verifyStandardWebhook(input: {
  payload: string
  headers: StandardWebhookHeaders
  secret: string
  now?: () => number
}): Promise<void> {
  const id = input.headers["webhook-id"]
  const timestampHeader = input.headers["webhook-timestamp"]
  const signatureHeader = input.headers["webhook-signature"]
  if (!id || !timestampHeader || !signatureHeader) {
    throw new WebhookSignatureError("Missing required webhook signature headers")
  }

  const timestamp = Number.parseInt(timestampHeader, 10)
  if (!Number.isFinite(timestamp)) throw new WebhookSignatureError("Invalid webhook timestamp")
  const nowSeconds = Math.floor((input.now?.() ?? Date.now()) / 1000)
  if (nowSeconds - timestamp > TOLERANCE_SECONDS) throw new WebhookSignatureError("Webhook timestamp too old")
  if (timestamp > nowSeconds + TOLERANCE_SECONDS) throw new WebhookSignatureError("Webhook timestamp too new")

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes(input.secret) as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${input.payload}`) as unknown as ArrayBuffer,
  )
  const expected = base64(signed)

  for (const versioned of signatureHeader.split(" ")) {
    const [version, signature] = versioned.split(",")
    if (version !== "v1" || !signature) continue
    if (timingSafeEqual(signature, expected)) return
  }
  throw new WebhookSignatureError("No matching webhook signature")
}

/**
 * Convenience: sign a payload the way Polar would. Test-only helper (fixtures
 * need valid signatures); the production path only verifies.
 */
export async function signStandardWebhook(input: {
  payload: string
  id: string
  timestampSeconds: number
  secret: string
}): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes(input.secret) as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${input.id}.${input.timestampSeconds}.${input.payload}`) as unknown as ArrayBuffer,
  )
  return `v1,${base64(signed)}`
}
