import { describe, expect, test } from "bun:test"
import { rewriteFileOrigin, serverOriginFilters, trustMainRendererOrigin } from "./renderer-origin"

// The packaged renderer is a file:// document. Chromium omits Origin on a plain
// fetch from such a page (so the HTTP API worked) but ALWAYS sends one on a
// WebSocket handshake, where the value is the literal "file://" — measured by
// opening a socket from a real file:// Electron page against a header-logging
// server. claxedo-server's loopback gate parses that origin and requires a
// loopback hostname; `new URL("file://").hostname` is "", so every upgrade was
// answered 403 and the terminal sat in `[Reconnecting... attempt n/6]`.
describe("rewriteFileOrigin", () => {
  const serverOrigin = "http://127.0.0.1:3001"

  test("replaces the renderer's file:// origin with the server origin", () => {
    expect(rewriteFileOrigin({ requestHeaders: { Origin: "file://" }, serverOrigin }))
      .toEqual({ Origin: "http://127.0.0.1:3001" })
  })

  test("matches the header case-insensitively", () => {
    expect(rewriteFileOrigin({ requestHeaders: { origin: "file://" }, serverOrigin }))
      .toEqual({ origin: "http://127.0.0.1:3001" })
  })

  // Laundering a real origin would hand any embedded page the trust we are
  // granting our own renderer, so only the exact file:// value is replaced.
  test("never launders a real origin into a trusted one", () => {
    expect(rewriteFileOrigin({ requestHeaders: { Origin: "https://evil.example" }, serverOrigin }))
      .toEqual({ Origin: "https://evil.example" })
  })

  test("leaves a request that carries no origin untouched", () => {
    expect(rewriteFileOrigin({ requestHeaders: { Accept: "application/json" }, serverOrigin }))
      .toEqual({ Accept: "application/json" })
  })

  test("preserves the other headers on the request", () => {
    expect(rewriteFileOrigin({
      requestHeaders: { Origin: "file://", "Sec-WebSocket-Key": "abc", Upgrade: "websocket" },
      serverOrigin,
    })).toEqual({ Origin: "http://127.0.0.1:3001", "Sec-WebSocket-Key": "abc", Upgrade: "websocket" })
  })
})

describe("serverOriginFilters", () => {
  // The ws: pattern is the whole point: WebSocket upgrades reach webRequest
  // under the ws:/wss: scheme, so an http-only filter would miss exactly the
  // requests that were being rejected.
  test("covers both the http and ws schemes for a loopback server", () => {
    expect(serverOriginFilters("http://127.0.0.1:3001")).toEqual({
      origin: "http://127.0.0.1:3001",
      urls: ["http://127.0.0.1:3001/*", "ws://127.0.0.1:3001/*"],
    })
  })

  test("uses the secure socket scheme for an https server", () => {
    expect(serverOriginFilters("https://claxedo.example:8443")).toEqual({
      origin: "https://claxedo.example:8443",
      urls: ["https://claxedo.example:8443/*", "wss://claxedo.example:8443/*"],
    })
  })

  test("scopes the filter to the server's own authority", () => {
    const filters = serverOriginFilters("http://127.0.0.1:52100/")
    expect(filters.urls.every((url) => url.includes("127.0.0.1:52100"))).toBe(true)
  })
})

// Registering the listener and applying the policy are separate mistakes to
// make, so drive the real callback the way Electron would rather than trusting
// that the two halves were wired together.
describe("trustMainRendererOrigin wiring", () => {
  function register(serverUrl: string) {
    let filter: { urls: string[] } | undefined
    let listener:
      | ((
          details: { requestHeaders: Record<string, string> },
          callback: (response: { requestHeaders: Record<string, string> }) => void,
        ) => void)
      | undefined
    trustMainRendererOrigin({
      serverUrl,
      onBeforeSendHeaders: (nextFilter, nextListener) => {
        filter = nextFilter
        listener = nextListener
      },
    })
    const send = (requestHeaders: Record<string, string>) => {
      let sent: Record<string, string> | undefined
      listener?.({ requestHeaders }, (response) => {
        sent = response.requestHeaders
      })
      return sent
    }
    return { filter, send }
  }

  test("registers a filter covering the server's ws upgrades", () => {
    expect(register("http://127.0.0.1:3001").filter).toEqual({
      urls: ["http://127.0.0.1:3001/*", "ws://127.0.0.1:3001/*"],
    })
  })

  test("rewrites the terminal socket's file:// origin as Electron would deliver it", () => {
    const { send } = register("http://127.0.0.1:3001")
    expect(send({ Origin: "file://", Upgrade: "websocket" })).toEqual({
      Origin: "http://127.0.0.1:3001",
      Upgrade: "websocket",
    })
  })

  test("passes a request with no origin straight through", () => {
    const { send } = register("http://127.0.0.1:3001")
    expect(send({ Accept: "application/json" })).toEqual({ Accept: "application/json" })
  })
})
