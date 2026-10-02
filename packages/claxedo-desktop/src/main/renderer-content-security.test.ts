import { describe, expect, test } from "bun:test"
import { contentSecurityPolicy, ContentSecurityPolicyError } from "@claxedo/app/content-security-policy"
import { rendererContentSecurityListener, rendererContentSecurityPolicy, type HeadersReceivedResponse } from "./renderer-content-security"

const DOCUMENT = "file:///Applications/Claxedo.app/Contents/Resources/app.asar/out/renderer/index.local.html"

function directive(policy: string, name: string) {
  return policy.split("; ").find((entry) => entry.startsWith(`${name} `))
}

function listen(options: { origin: Promise<string>; devServerUrl?: string; relayOrigins?: readonly string[] }) {
  return rendererContentSecurityListener({
    serverOrigin: options.origin,
    relayOrigins: options.relayOrigins ?? [],
    isRendererDocument: (url) => url === DOCUMENT,
    ...(options.devServerUrl ? { devServerUrl: options.devServerUrl } : {}),
  })
}

function respond(listener: ReturnType<typeof listen>, details: Parameters<ReturnType<typeof listen>>[0]) {
  return new Promise<HeadersReceivedResponse>((resolve) => listener(details, resolve))
}

describe("the renderer policy", () => {
  test("names exactly the daemon's origin for every network directive", () => {
    const policy = rendererContentSecurityPolicy("http://127.0.0.1:2593", [])
    expect(directive(policy, "connect-src")).toBe("connect-src 'self' http://127.0.0.1:2593 ws://127.0.0.1:2593")
    expect(directive(policy, "img-src")).toBe("img-src 'self' data: blob: https: http://127.0.0.1:2593")
    expect(directive(policy, "default-src")).toBe("default-src 'self'")
    expect(directive(policy, "script-src")).toBe("script-src 'self' 'wasm-unsafe-eval' blob:")
    expect(directive(policy, "frame-src")).toBe("frame-src 'none'")
    expect(directive(policy, "form-action")).toBe("form-action 'none'")
    expect(directive(policy, "object-src")).toBe("object-src 'none'")
    expect(directive(policy, "base-uri")).toBe("base-uri 'none'")
    expect(policy).not.toContain("*")
  })

  test("refuses a wildcard, a path-only value or a non-web origin", () => {
    expect(() => contentSecurityPolicy({ servers: ["http://127.0.0.1:*"], frames: "none" })).toThrow(ContentSecurityPolicyError)
    expect(() => contentSecurityPolicy({ servers: ["https://*.claxedo.com"], frames: "none" })).toThrow(ContentSecurityPolicyError)
    expect(() => contentSecurityPolicy({ servers: ["file:///tmp"], frames: "none" })).toThrow(ContentSecurityPolicyError)
    expect(() => contentSecurityPolicy({ servers: ["/api"], frames: "none" })).toThrow(ContentSecurityPolicyError)
    expect(directive(contentSecurityPolicy({ servers: ["https://cp.example.com/api/"], frames: "none" }), "connect-src")).toBe("connect-src 'self' https://cp.example.com wss://cp.example.com")
  })
})

describe("stamping the renderer document", () => {
  test("holds the document until the daemon's origin is known, then replaces any policy it carried", async () => {
    let announce!: (origin: string) => void
    const origin = new Promise<string>((resolve) => {
      announce = resolve
    })
    const listener = listen({ origin })
    let settled = false
    const response = respond(listener, { url: DOCUMENT, resourceType: "mainFrame", responseHeaders: { "content-security-policy": ["default-src *"], "x-other": ["1"] } }).then((value) => {
      settled = true
      return value
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    announce("http://127.0.0.1:2601")
    const headers = (await response).responseHeaders ?? {}
    expect(headers["content-security-policy"]).toBeUndefined()
    expect(headers["x-other"]).toEqual(["1"])
    expect(directive(headers["Content-Security-Policy"]?.[0] ?? "", "connect-src")).toBe("connect-src 'self' http://127.0.0.1:2601 ws://127.0.0.1:2601")
  })

  test("a signed desktop's relay is reachable over HTTP and WebSocket, and nothing else of the account's is", async () => {
    const listener = listen({ origin: Promise.resolve("http://127.0.0.1:2593"), relayOrigins: ["https://relay.example"] })
    const policy = (await respond(listener, { url: DOCUMENT, resourceType: "mainFrame" })).responseHeaders?.["Content-Security-Policy"]?.[0] ?? ""
    expect(directive(policy, "connect-src")).toBe("connect-src 'self' http://127.0.0.1:2593 https://relay.example ws://127.0.0.1:2593 wss://relay.example")
  })

  test("leaves subresources and other documents alone", async () => {
    const listener = listen({ origin: Promise.resolve("http://127.0.0.1:2593") })
    expect(await respond(listener, { url: DOCUMENT.replace("index.local.html", "assets/main.js"), resourceType: "script" })).toEqual({})
    expect(await respond(listener, { url: "file:///tmp/evil.html", resourceType: "mainFrame" })).toEqual({})
    expect(await respond(listener, { url: DOCUMENT, resourceType: "subFrame" })).toEqual({})
  })

  test("a server that never started leaves the document with no server to reach", async () => {
    const listener = listen({ origin: Promise.reject(new Error("daemon unresolved")) })
    const policy = (await respond(listener, { url: DOCUMENT, resourceType: "mainFrame" })).responseHeaders?.["Content-Security-Policy"]?.[0] ?? ""
    expect(directive(policy, "connect-src")).toBe("connect-src 'self'")
  })

  test("the dev server adds its own origin and Vite's inline and eval, nothing wider", async () => {
    const listener = listen({ origin: Promise.resolve("http://127.0.0.1:2593"), devServerUrl: "http://localhost:5173/" })
    const policy = (await respond(listener, { url: DOCUMENT, resourceType: "mainFrame" })).responseHeaders?.["Content-Security-Policy"]?.[0] ?? ""
    expect(directive(policy, "connect-src")).toBe("connect-src 'self' http://127.0.0.1:2593 http://localhost:5173 ws://127.0.0.1:2593 ws://localhost:5173")
    expect(directive(policy, "script-src")).toBe("script-src 'self' 'wasm-unsafe-eval' blob: 'unsafe-inline' 'unsafe-eval'")
  })
})
