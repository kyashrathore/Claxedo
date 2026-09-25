const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

export function ascendingMessageIds(clock: () => number = Date.now): () => string {
  let counter = 0
  return () => {
    const ordered = (BigInt(clock()) * 4096n + BigInt(++counter)) & 0xffffffffffffn
    const random = Array.from(crypto.getRandomValues(new Uint8Array(14)), (byte) => BASE62[byte % 62]).join("")
    return `msg_${ordered.toString(16).padStart(12, "0")}${random}`
  }
}
