import { describe, expect, test } from "bun:test"
import {
  bearerToken,
  escapeRegExp,
  normalizePem,
  slug,
  trimToEmpty,
  trimToUndefined,
  utf8ByteLength,
} from "./string"

describe("trim", () => {
  test("trimToUndefined returns the trimmed value and is arity 1", () => {
    expect(trimToUndefined(" a ")).toBe("a")
    expect(trimToUndefined("   ")).toBeUndefined()
    expect(trimToUndefined(5)).toBeUndefined()
    // Point-free over map: a second argument (the index) must not change it.
    expect([" a ", "  "].map(trimToUndefined)).toEqual(["a", undefined])
  })

  test("trimToEmpty is total on string", () => {
    expect(trimToEmpty(" a ")).toBe("a")
    expect(trimToEmpty(null)).toBe("")
  })
})

describe("normalizePem", () => {
  test("trims first, so a trailing literal escape survives as a newline", () => {
    expect(normalizePem("  -----BEGIN-----\\nbody\\n  ")).toBe("-----BEGIN-----\nbody\n")
    expect(normalizePem("  ")).toBeUndefined()
  })
})

describe("bearerToken", () => {
  test("accepts exactly one credential, case-insensitively", () => {
    expect(bearerToken("Bearer abc")).toBe("abc")
    expect(bearerToken("bearer   abc")).toBe("abc")
    expect(bearerToken("  Bearer abc  ")).toBe("abc")
  })

  test("a multi-credential header yields undefined, never a truncated token", () => {
    expect(bearerToken("Bearer abc, Basic zzz")).toBeUndefined()
    expect(bearerToken("Bearer abc def")).toBeUndefined()
    expect(bearerToken("Basic abc")).toBeUndefined()
    expect(bearerToken(null)).toBeUndefined()
  })
})

describe("escapeRegExp", () => {
  test("the escaped value matches itself literally", () => {
    const raw = "a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o"
    expect(new RegExp(escapeRegExp(raw)).test(raw)).toBe(true)
    expect(new RegExp(`^${escapeRegExp("a.c")}$`).test("abc")).toBe(false)
  })
})

describe("slug", () => {
  test("collapses runs, strips edges, separates on non-ASCII", () => {
    expect(slug("  Hello,   World!  ")).toBe("hello-world")
    expect(slug("Ünïcode")).toBe("n-code")
    expect(slug("---", "fallback")).toBe("fallback")
    expect(slug(undefined, "fallback")).toBe("fallback")
    expect(slug("---")).toBe("")
  })
})

describe("utf8ByteLength", () => {
  test("agrees with TextEncoder, including surrogate pairs and lone surrogates", () => {
    const encoder = new TextEncoder()
    for (const value of ["", "abc", "£", "€", "😀", "a😀b", "\ud83d", "a\ud83dz", "\udc00"]) {
      expect(utf8ByteLength(value)).toBe(encoder.encode(value).byteLength)
    }
  })
})
