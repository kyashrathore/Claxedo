const RANDOM_LENGTH = 14
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

function timeHex(ordered: bigint) {
  let hex = ""
  for (let index = 0; index < 6; index += 1) {
    hex += Number((ordered >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, "0")
  }
  return hex
}

function randomBase62(length: number) {
  let out = ""
  for (const byte of crypto.getRandomValues(new Uint8Array(length))) out += BASE62[byte % 62]
  return out
}

export function createMessageIds(clock: () => number = Date.now): () => string {
  let lastTimestamp = 0
  let counter = 0
  return () => {
    const now = clock()
    if (now !== lastTimestamp) {
      lastTimestamp = now
      counter = 0
    }
    counter += 1
    return `msg_${timeHex(BigInt(now) * 0x1000n + BigInt(counter))}${randomBase62(RANDOM_LENGTH)}`
  }
}
