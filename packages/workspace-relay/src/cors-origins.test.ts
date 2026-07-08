import { describe, expect, test } from "bun:test"
import { createOriginMatcher, DEFAULT_RELAY_APP_ORIGINS, parseAllowedOrigins } from "./cors-origins"

describe("cors origin patterns", () => {
  test("parses comma-separated entries and returns undefined for empty input", () => {
    expect(parseAllowedOrigins(undefined)).toBeUndefined()
    expect(parseAllowedOrigins("  ")).toBeUndefined()
    expect(parseAllowedOrigins("https://a.example.com, https://*.b.example.com ,")).toEqual([
      "https://a.example.com",
      "https://*.b.example.com",
    ])
  })

  test("matches exact origins only exactly", () => {
    const matcher = createOriginMatcher(["https://app.example.com"])
    expect(matcher("https://app.example.com")).toBe(true)
    expect(matcher("https://evil-app.example.com")).toBe(false)
    expect(matcher("https://app.example.com.evil.io")).toBe(false)
  })

  test("wildcard subdomain entries match subdomains but not the apex or lookalikes", () => {
    const matcher = createOriginMatcher(["https://*.example.com"])
    expect(matcher("https://app.example.com")).toBe(true)
    expect(matcher("https://a.b.example.com")).toBe(true)
    expect(matcher("https://example.com")).toBe(false)
    expect(matcher("https://evilexample.com")).toBe(false)
    expect(matcher("https://app.example.com:8443")).toBe(false)
    expect(matcher("http://app.example.com")).toBe(false)
  })

  test("localhost port wildcards match numeric ports only", () => {
    const matcher = createOriginMatcher(["http://localhost:*", "http://127.0.0.1:*"])
    expect(matcher("http://localhost:3000")).toBe(true)
    expect(matcher("http://127.0.0.1:5173")).toBe(true)
    expect(matcher("http://localhost:3000.evil.io")).toBe(false)
    expect(matcher("https://localhost:3000")).toBe(false)
  })

  test("default list reproduces the historical built-in policy", () => {
    const matcher = createOriginMatcher(DEFAULT_RELAY_APP_ORIGINS)
    expect(matcher("https://opencode.ai")).toBe(true)
    expect(matcher("https://app.opencode.ai")).toBe(true)
    expect(matcher("https://claxedo.com")).toBe(true)
    expect(matcher("https://app.claxedo.com")).toBe(true)
    expect(matcher("http://localhost:4444")).toBe(true)
    expect(matcher("https://evilclaxedo.com")).toBe(false)
    expect(matcher("https://claxedo.com.evil.io")).toBe(false)
  })
})
