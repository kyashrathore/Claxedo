import { describe, expect, test } from "bun:test"
import { requestUrl, scopeUrl } from "./url"

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

describe("requestUrl", () => {
  test("returns a string input unchanged", () => {
    expect(requestUrl("http://localhost:3001/api/session")).toBe("http://localhost:3001/api/session")
  })

  test("returns the href of a URL input", () => {
    expect(requestUrl(new URL("http://localhost:3001/api/session?a=1"))).toBe("http://localhost:3001/api/session?a=1")
  })

  test("returns the url of a Request input rather than [object Object]", () => {
    expect(requestUrl(new Request("http://localhost:3001/api/session"))).toBe("http://localhost:3001/api/session")
  })
})
