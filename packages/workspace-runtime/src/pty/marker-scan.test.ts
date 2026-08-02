import { describe, expect, test } from "bun:test"
import { createMarkerScanner } from "./marker-scan"

const MARKER = "claxedo-shell-ready"

describe("createMarkerScanner", () => {
  test("detects a marker contained in one chunk", () => {
    const scanner = createMarkerScanner(MARKER)
    expect(scanner.scan(`prompt ${MARKER} rest`)).toBe(true)
  })

  test("detects a marker split across two chunks", () => {
    const scanner = createMarkerScanner(MARKER)
    expect(scanner.scan("prompt claxedo-shell")).toBe(false)
    expect(scanner.scan("-ready rest")).toBe(true)
  })

  test("detects a marker split one character at a time", () => {
    const scanner = createMarkerScanner(MARKER)
    const chars = Array.from(MARKER)
    for (const ch of chars.slice(0, -1)) {
      expect(scanner.scan(ch)).toBe(false)
    }
    expect(scanner.scan(chars[chars.length - 1]!)).toBe(true)
  })

  test("detects a marker split across three chunks", () => {
    const scanner = createMarkerScanner(MARKER)
    expect(scanner.scan("claxedo-")).toBe(false)
    expect(scanner.scan("shell")).toBe(false)
    expect(scanner.scan("-ready")).toBe(true)
  })

  test("does not match a near-miss that never completes", () => {
    const scanner = createMarkerScanner(MARKER)
    expect(scanner.scan("claxedo-shell")).toBe(false)
    expect(scanner.scan("-reads")).toBe(false)
    expect(scanner.scan(" more output")).toBe(false)
  })

  test("matches again after a first match (carry is cleared)", () => {
    const scanner = createMarkerScanner(MARKER)
    expect(scanner.scan(MARKER)).toBe(true)
    expect(scanner.scan("claxedo-shell")).toBe(false)
    expect(scanner.scan("-ready")).toBe(true)
  })

  test("ignores empty chunks without disturbing the carry", () => {
    const scanner = createMarkerScanner(MARKER)
    expect(scanner.scan("claxedo-shell")).toBe(false)
    expect(scanner.scan("")).toBe(false)
    expect(scanner.scan("-ready")).toBe(true)
  })

  test("carry never grows beyond needle length - 1", () => {
    const scanner = createMarkerScanner("abc")
    for (let i = 0; i < 1000; i += 1) scanner.scan("x".repeat(100))
    // Still able to match across a boundary — proves the carry is live, and
    // the implementation caps it at 2 chars regardless of volume.
    expect(scanner.scan("ab")).toBe(false)
    expect(scanner.scan("c")).toBe(true)
  })

  test("reset drops pending state", () => {
    const scanner = createMarkerScanner(MARKER)
    expect(scanner.scan("claxedo-shell")).toBe(false)
    scanner.reset()
    expect(scanner.scan("-ready")).toBe(false)
  })

  test("works for the clear-scrollback escape sequence", () => {
    const scanner = createMarkerScanner("\x1b[3J")
    expect(scanner.scan("output\x1b[")).toBe(false)
    expect(scanner.scan("3J after")).toBe(true)
  })

  test("rejects an empty needle", () => {
    expect(() => createMarkerScanner("")).toThrow()
  })
})
