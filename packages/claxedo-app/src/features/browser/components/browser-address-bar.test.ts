/**
 * `navigate()` accepts only http(s) URLs, so raw address-bar input like `x.com`
 * would snap the pane to `about:blank`; `normalizeAddressBarInput` applies
 * Chromium-style completion first.
 */

import { describe, expect, test } from "bun:test"
import { normalizeAddressBarInput, sameOrigin } from "./browser-url"

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

describe("sameOrigin", () => {
  test("matches scheme, host, and port, ignoring path and fragment", () => {
    expect(sameOrigin("https://app.example.com/a#x", "https://app.example.com/b?y=1")).toBe(true)
    expect(sameOrigin("https://app.example.com/", "https://app.example.com:8443/")).toBe(false)
    expect(sameOrigin("http://app.example.com/", "https://app.example.com/")).toBe(false)
    expect(sameOrigin("https://evil.example.net/", "https://app.example.com/")).toBe(false)
  })

  test("opaque origins only match on the exact URL", () => {
    expect(sameOrigin("about:blank", "about:blank")).toBe(true)
    expect(sameOrigin("data:text/html,hi", "about:blank")).toBe(false)
  })

  test("an unparsable URL never matches", () => {
    expect(sameOrigin("", "https://app.example.com/")).toBe(false)
    expect(sameOrigin("https://app.example.com/", "not a url")).toBe(false)
  })
})
