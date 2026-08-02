import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { bytesToBase64 } from "./cloudflare"

/**
 * `bytesToBase64` is on the path EVERY relayed frame pays — both the WebSocket
 * frame encoder (`socketFrame`) and the user-hosted HTTP request body. It was
 * rewritten from a per-byte `binary += String.fromCharCode(byte)` loop to a
 * chunked `String.fromCharCode.apply` over 0x8000-byte subarrays.
 *
 * The chunking is only safe if it is byte-identical, and the interesting inputs
 * are exactly at the chunk boundary — an off-by-one in the `subarray` bounds
 * would corrupt one byte per 32 KiB, which is the kind of defect that shows up
 * as a rare mangled terminal cell rather than a failed test. So the pre-fix
 * implementation stays here as the reference oracle.
 */
function bytesToBase64PerByte(bytes: Uint8Array) {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const CHUNK = 0x8000

function filled(length: number, seed: number) {
  const bytes = new Uint8Array(length)
  // A deterministic non-repeating pattern: a constant fill would pass even if
  // chunk boundaries dropped or duplicated a byte.
  let state = seed || 1
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    bytes[i] = state & 0xff
  }
  return bytes
}

describe("bytesToBase64", () => {
  test("matches the per-byte reference on the empty and single-byte inputs", () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe(bytesToBase64PerByte(new Uint8Array(0)))
    expect(bytesToBase64(new Uint8Array(0))).toBe("")

    for (const byte of [0, 1, 0x7f, 0x80, 0xfe, 0xff]) {
      const single = new Uint8Array([byte])
      expect(bytesToBase64(single), `single byte 0x${byte.toString(16)}`)
        .toBe(bytesToBase64PerByte(single))
    }
  })

  test("matches the per-byte reference across the 32k chunk boundary", () => {
    // CHUNK-1 / CHUNK / CHUNK+1 are where a wrong `subarray` bound shows up, and
    // the same triple around 2*CHUNK catches a bound that is only wrong after
    // the first iteration.
    for (const length of [CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK - 1, 2 * CHUNK, 2 * CHUNK + 1]) {
      const bytes = filled(length, length)
      expect(bytesToBase64(bytes), `length ${length}`).toBe(bytesToBase64PerByte(bytes))
    }
  })

  test("matches the per-byte reference on a payload larger than 1 MiB", () => {
    // Not a round number: 1 MiB + 12345 leaves a partial final chunk, so the
    // tail path is exercised rather than only whole chunks.
    const bytes = filled(1024 * 1024 + 12345, 0xc0ffee)
    expect(bytesToBase64(bytes)).toBe(bytesToBase64PerByte(bytes))
  })

  test("covers the full byte range including the high half", () => {
    // btoa() throws above U+00FF, so a chunk built with the wrong charCode
    // conversion would fail loudly here rather than silently mangling bytes.
    const bytes = new Uint8Array(256)
    for (let i = 0; i < 256; i++) bytes[i] = i
    expect(bytesToBase64(bytes)).toBe(bytesToBase64PerByte(bytes))
  })

  test("round-trips through atob back to the original bytes", () => {
    const bytes = filled(CHUNK * 3 + 7, 42)
    const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (char) => char.charCodeAt(0))
    expect(decoded).toEqual(bytes)
  })

  test("the chunk size stays under the argument-count ceiling", async () => {
    // Deliberately a source assertion, not a behavioral one. Raising the chunk
    // is only unsafe on the ENGINE THAT RUNS PRODUCTION: Bun/JSC accepts
    // `String.fromCharCode.apply` with 0x80000 arguments and only throws
    // RangeError at 0x100000, so a test that merely encodes a large payload
    // passes here and then blows up on workerd, where the limit is lower.
    // 0x8000 is the conventional ceiling that every engine accepts; this guard
    // is what makes raising it a deliberate act rather than a silent one.
    const source = await readFile(new URL("./cloudflare.ts", import.meta.url), "utf8")
    const declared = source.match(/^const BASE64_CHUNK_BYTES = (0x[0-9a-fA-F]+|\d+)$/m)?.[1]
    expect(declared, "BASE64_CHUNK_BYTES must be declared as a literal in cloudflare.ts").toBeDefined()
    expect(Number(declared)).toBeLessThanOrEqual(0x8000)
    expect(Number(declared)).toBeGreaterThan(0)
  })
})
