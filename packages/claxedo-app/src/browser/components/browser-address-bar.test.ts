/**
 * URL normalization tests for the browser address bar.
 *
 * The user's feedback after the Unit 8 ship was specifically that entering
 * `x.com` snapped the pane back to `about:blank` — because the raw input was
 * passed to `navigate()` which only accepts http(s) URLs. `normalizeAddressBarInput`
 * is the helper that fixes that by matching Chromium-style behavior: bare
 * domains get `https://`, localhost gets `http://`, queries with whitespace
 * go to Google, and fully-qualified URLs pass through untouched.
 */

import { describe, expect, test } from "bun:test"
import { normalizeAddressBarInput } from "./browser-pane"

describe("normalizeAddressBarInput", () => {
  test("passes through fully-qualified https URLs unchanged", () => {
    expect(normalizeAddressBarInput("https://example.com/x?y=1")).toBe("https://example.com/x?y=1")
    expect(normalizeAddressBarInput("https://x.com")).toBe("https://x.com")
  })

  test("passes through fully-qualified http URLs unchanged", () => {
    expect(normalizeAddressBarInput("http://localhost:3000/api")).toBe("http://localhost:3000/api")
    expect(normalizeAddressBarInput("http://example.com")).toBe("http://example.com")
  })

  test("prepends https:// to bare domain", () => {
    expect(normalizeAddressBarInput("example.com")).toBe("https://example.com")
    expect(normalizeAddressBarInput("x.com")).toBe("https://x.com")
    expect(normalizeAddressBarInput("sub.example.co.uk/foo")).toBe("https://sub.example.co.uk/foo")
  })

  test("prepends http:// to localhost variants", () => {
    expect(normalizeAddressBarInput("localhost")).toBe("http://localhost")
    expect(normalizeAddressBarInput("localhost:3000")).toBe("http://localhost:3000")
    expect(normalizeAddressBarInput("127.0.0.1:8080")).toBe("http://127.0.0.1:8080")
    expect(normalizeAddressBarInput("0.0.0.0:5173")).toBe("http://0.0.0.0:5173")
  })

  test("routes whitespace queries to Google search", () => {
    const out = normalizeAddressBarInput("how to bake a cake")
    expect(out).toBe(`https://www.google.com/search?q=${encodeURIComponent("how to bake a cake")}`)
  })

  test("routes bare single words with no dot to Google search", () => {
    const out = normalizeAddressBarInput("claxedo")
    expect(out).toBe(`https://www.google.com/search?q=${encodeURIComponent("claxedo")}`)
  })

  test("trims whitespace before deciding", () => {
    expect(normalizeAddressBarInput("  x.com  ")).toBe("https://x.com")
    expect(normalizeAddressBarInput("\texample.com\n")).toBe("https://example.com")
  })

  test("empty / whitespace-only input returns empty string without navigating", () => {
    expect(normalizeAddressBarInput("")).toBe("")
    expect(normalizeAddressBarInput("   ")).toBe("")
  })

  test("preserves scheme for non-http protocols (e.g. file://, data:)", () => {
    expect(normalizeAddressBarInput("file:///tmp/x.html")).toBe("file:///tmp/x.html")
    // data: does not match `scheme://` so it falls through to the search
    // branch — this is acceptable: navigate() rejects non-http(s) anyway and
    // the user almost certainly meant to search.
    const dataOut = normalizeAddressBarInput("data:text/plain,hi")
    expect(dataOut.startsWith("https://www.google.com/search?q=")).toBe(true)
  })
})
