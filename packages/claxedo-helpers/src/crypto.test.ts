import { describe, expect, test } from "bun:test"
import { base64UrlDecode, base64UrlEncode, prefixedRandomId, timingSafeEqualStrings } from "./crypto"

describe("base64UrlEncode", () => {
  test("matches Node's base64url byte for byte, and is unpadded", () => {
    for (let length = 0; length < 40; length += 1) {
      const bytes = new Uint8Array(length)
      for (let i = 0; i < length; i += 1) bytes[i] = (i * 37 + 11) % 256
      const encoded = base64UrlEncode(bytes)
      expect(encoded).toBe(Buffer.from(bytes).toString("base64url"))
      expect(encoded).not.toContain("=")
      expect(encoded).not.toContain("+")
      expect(encoded).not.toContain("/")
    }
  })

  test("accepts an ArrayBuffer and survives an input larger than the spread limit", () => {
    const bytes = new Uint8Array(200_000).fill(0xff)
    expect(base64UrlEncode(bytes.buffer)).toBe(Buffer.from(bytes).toString("base64url"))
  })
})

describe("timingSafeEqualStrings", () => {
  test("equality without an early length return", () => {
    expect(timingSafeEqualStrings("", "")).toBe(true)
    expect(timingSafeEqualStrings("abc", "abc")).toBe(true)
    expect(timingSafeEqualStrings("abc", "abd")).toBe(false)
    expect(timingSafeEqualStrings("abc", "abcd")).toBe(false)
    expect(timingSafeEqualStrings("abc", "")).toBe(false)
  })

  test("the length XOR seed keeps a prefix from matching its extension", () => {
    // Both loops read past the end of the shorter input, where charCodeAt is
    // NaN and NaN|0 is 0; only the seed distinguishes these.
    expect(timingSafeEqualStrings("a", "a ")).toBe(false)
    expect(timingSafeEqualStrings(" ", "")).toBe(false)
  })

  test("injective over unpaired surrogates", () => {
    expect(timingSafeEqualStrings("\ud800", "\ud801")).toBe(false)
    expect(timingSafeEqualStrings("\ud800", "\ud800")).toBe(true)
  })
})

describe("prefixedRandomId", () => {
  test("prefix, underscore, and exactly 32 lowercase hex characters", () => {
    expect(prefixedRandomId("ws")).toMatch(/^ws_[0-9a-f]{32}$/)
  })

  test("distinct across calls", () => {
    const ids = new Set(Array.from({ length: 500 }, () => prefixedRandomId("ws")))
    expect(ids.size).toBe(500)
  })
})

describe("base64UrlDecode", () => {
  test("round-trips every byte value", () => {
    const bytes = new Uint8Array(256).map((_, index) => index)
    expect([...base64UrlDecode(base64UrlEncode(bytes))]).toEqual([...bytes])
  })

  test("decodes each unpadded remainder length", () => {
    for (const length of [1, 2, 3, 4, 5]) {
      const bytes = new Uint8Array(length).fill(251)
      expect([...base64UrlDecode(base64UrlEncode(bytes))]).toEqual([...bytes])
    }
  })

  test("standard base64 is rejected, not silently accepted", () => {
    // "+/" are the standard alphabet; base64url spells them "-_".
    expect(() => base64UrlDecode("a+b/c")).toThrow("not base64url")
    expect(() => base64UrlDecode("YWJj=")).toThrow("not base64url")
  })

  test("an empty string is rejected rather than decoding to no bytes", () => {
    expect(() => base64UrlDecode("")).toThrow("not base64url")
  })

  test("a length that cannot be base64 raises the same error as a bad alphabet", () => {
    expect(() => base64UrlDecode("a")).toThrow("not base64url")
  })

  test("the caller's error factory owns both failure modes", () => {
    class Denied extends Error {}
    const error = (message: string) => new Denied(message)
    expect(() => base64UrlDecode("a+b", { error })).toThrow(Denied)
    expect(() => base64UrlDecode("a", { error })).toThrow(Denied)
  })
})
