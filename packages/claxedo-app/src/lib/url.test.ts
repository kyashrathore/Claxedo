import { describe, expect, test } from "bun:test"
import { scopeUrl } from "./url"

describe("scopeUrl", () => {
  test("normalizes 127.0.0.1 to localhost and strips trailing slashes", () => {
    expect(scopeUrl("http://127.0.0.1:3001///")).toBe("http://localhost:3001")
  })

  test("preserves path and query while normalizing loopback host", () => {
    expect(scopeUrl("https://127.0.0.1:4444/api/session/?cursor=abc")).toBe(
      "https://localhost:4444/api/session/?cursor=abc",
    )
  })

  test("strips trailing slashes from regular URLs", () => {
    expect(scopeUrl("https://example.com/workspace///")).toBe("https://example.com/workspace")
  })

  test("falls back to string normalization for invalid URLs", () => {
    expect(scopeUrl(" not a url/// ")).toBe("not a url")
  })
})
