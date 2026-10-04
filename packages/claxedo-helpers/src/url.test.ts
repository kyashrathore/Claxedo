import { describe, expect, test } from "bun:test"
import {
  isLocalDevelopmentHostname,
  isLoopbackHostname,
  isLoopbackHttpUrl,
  joinUrl,
  stripTrailingSlashes,
} from "./url"

describe("isLoopbackHostname", () => {
  test("the loopback host itself, in either bracket form and any case", () => {
    for (const host of ["localhost", "LOCALHOST", " localhost ", "127.0.0.1", "::1", "[::1]"]) {
      expect(isLoopbackHostname(host)).toBe(true)
    }
  })

  test("broadening is fail-OPEN, so nothing else qualifies", () => {
    for (const host of [
      "app.localhost",
      "127.0.0.2",
      "127.1",
      "0.0.0.0",
      "::",
      "localhost.evil.com",
      "evil.com",
      "[::1",
      "::1]",
      "[127.0.0.1]",
      undefined,
      null,
      "",
    ]) {
      expect(isLoopbackHostname(host)).toBe(false)
    }
  })
})

describe("isLocalDevelopmentHostname", () => {
  test("adds *.localhost on top of loopback", () => {
    expect(isLocalDevelopmentHostname("app.localhost")).toBe(true)
    expect(isLocalDevelopmentHostname("localhost")).toBe(true)
    expect(isLocalDevelopmentHostname("127.0.0.1")).toBe(true)
    expect(isLocalDevelopmentHostname("localhost.evil.com")).toBe(false)
    expect(isLocalDevelopmentHostname(undefined)).toBe(false)
  })
})

describe("isLoopbackHttpUrl", () => {
  test("accepts both http and https on a loopback host", () => {
    expect(isLoopbackHttpUrl("http://localhost:4096/x")).toBe(true)
    expect(isLoopbackHttpUrl("https://127.0.0.1/")).toBe(true)
    expect(isLoopbackHttpUrl("http://[::1]:80/")).toBe(true)
  })

  test("rejects other hosts, other protocols and unparseable input", () => {
    expect(isLoopbackHttpUrl("http://evil.com/")).toBe(false)
    expect(isLoopbackHttpUrl("ws://localhost/")).toBe(false)
    expect(isLoopbackHttpUrl("file:///tmp/x")).toBe(false)
    expect(isLoopbackHttpUrl("not a url")).toBe(false)
    expect(isLoopbackHttpUrl(undefined)).toBe(false)
  })
})

describe("joinUrl", () => {
  test("a base path is preserved rather than reset to the origin", () => {
    expect(joinUrl("https://x.dev/api/v1", "/users")).toBe("https://x.dev/api/v1/users")
    expect(joinUrl("https://x.dev/api/v1/", "users")).toBe("https://x.dev/api/v1/users")
    expect(joinUrl("https://x.dev", "/users")).toBe("https://x.dev/users")
    expect(joinUrl("https://x.dev///", "///users")).toBe("https://x.dev/users")
  })

  test("an absolute URL is rejected where a path was expected", () => {
    for (const absolute of ["https://evil.com/users", "  https://evil.com/users  ", "javascript:alert(1)", "x:opaque"]) {
      expect(() => joinUrl("https://x.dev/api", absolute)).toThrow("not an absolute URL")
    }
  })

  test("a host-relative input cannot retarget the join either", () => {
    expect(joinUrl("https://x.dev/api", "//evil.com/users")).toBe("https://x.dev/api/evil.com/users")
    expect(joinUrl("https://x.dev/api", "\\\\evil.com\\users")).toBe("https://x.dev/api/evil.com/users")
  })

  test("a colon in a later segment is still a path", () => {
    expect(joinUrl("https://x.dev/api", "a/b:c")).toBe("https://x.dev/api/a/b:c")
  })
})

describe("stripTrailingSlashes", () => {
  test("trims, strips every trailing slash, and does not preserve a lone root", () => {
    expect(stripTrailingSlashes(" https://x.dev/// ")).toBe("https://x.dev")
    expect(stripTrailingSlashes("/")).toBe("")
    expect(stripTrailingSlashes("///")).toBe("")
  })
})
