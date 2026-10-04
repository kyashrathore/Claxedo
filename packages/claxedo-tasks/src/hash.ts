/**
 * Request identity for command receipts. The hash answers one question — is
 * this the same request the receipt was written for, or a different request
 * reusing its `clientRequestId` — so it is computed over a key-ordered
 * rendering, not over the caller's byte order.
 *
 * `workspace-runtime`'s `canonicalJson` renders the same notion for a
 * different purpose. This kit cannot import it — an optional catalog depending
 * on the runtime package inverts the dependency the product boundary
 * enforces — so the rendering is restated here and stays private to hashing.
 */

function canonicalRequestJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalRequestJson(entry)).join(",")}]`
  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalRequestJson(entry)}`)
  return `{${entries.join(",")}}`
}

export async function hashRequest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalRequestJson(value)))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
