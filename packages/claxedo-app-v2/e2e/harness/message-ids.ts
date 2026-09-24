const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/**
 * Both apps order a transcript by message id, and the runtime gives a prompt
 * sent without one a random `msg_<uuid>`, so API-arranged turns would land out
 * of order. This is the app's own shape: `msg_`, 12 hex of time*4096+counter,
 * then 14 base62.
 */
export function ascendingMessageIds(clock: () => number = Date.now): () => string {
  let counter = 0
  return () => {
    const ordered = (BigInt(clock()) * 4096n + BigInt(++counter)) & 0xffffffffffffn
    const random = Array.from(crypto.getRandomValues(new Uint8Array(14)), (byte) => BASE62[byte % 62]).join("")
    return `msg_${ordered.toString(16).padStart(12, "0")}${random}`
  }
}
