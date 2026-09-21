import { describe, expect, test } from "bun:test"

import { DEV_RENDERER_CSP, PACKAGED_RENDERER_CSP } from "./document-csp"
import { createElectronRenderer } from "../../vite.renderer"

describe("packaged renderer document CSP", () => {
  test("is a real policy: self scripts, no inline script, no eval", () => {
    expect(PACKAGED_RENDERER_CSP).toContain("default-src 'self'")
    expect(PACKAGED_RENDERER_CSP).toContain("script-src 'self' 'wasm-unsafe-eval'")
    const scriptSrc = PACKAGED_RENDERER_CSP.match(/script-src ([^;]+)/)?.[1] ?? ""
    for (const token of scriptSrc.split(/\s+/)) {
      expect(["'unsafe-inline'", "'unsafe-eval'", "http:", "https:"]).not.toContain(token)
    }
  })

  test("covers the app's actual endpoints: local server, user servers, ws streams", () => {
    const connectSrc = PACKAGED_RENDERER_CSP.match(/connect-src ([^;]+)/)?.[1] ?? ""
    for (const source of ["'self'", "http:", "https:", "ws:", "wss:"]) {
      expect(connectSrc).toContain(source)
    }
  })

  test("locks down embeds, objects, base and forms", () => {
    expect(PACKAGED_RENDERER_CSP).toContain("object-src 'none'")
    expect(PACKAGED_RENDERER_CSP).toContain("base-uri 'none'")
    expect(PACKAGED_RENDERER_CSP).toContain("form-action 'none'")
    expect(PACKAGED_RENDERER_CSP).toContain("worker-src 'self' blob:")
    expect(PACKAGED_RENDERER_CSP).toContain("frame-src http: https:")
  })

  test("dev policy is deliberately looser for the Vite client", () => {
    expect(DEV_RENDERER_CSP).toContain("unsafe-eval")
    expect(DEV_RENDERER_CSP).toContain("unsafe-inline")
    expect(DEV_RENDERER_CSP).toContain("object-src 'none'")
    expect(DEV_RENDERER_CSP).toContain("base-uri 'none'")
  })
})

describe("renderer document CSP plugin", () => {
  test("injects the packaged policy via transformIndexHtml in production mode", () => {
    const plugin = createElectronRenderer("production").plugins?.find(
      (p) => (p as { name?: string }).name === "desktop-renderer-document-csp",
    ) as { transformIndexHtml?: { handler: () => Array<{ tag: string; attrs: Record<string, string> }> } }
    expect(plugin).toBeDefined()
    const tags = plugin.transformIndexHtml!.handler()
    expect(tags).toEqual([
      expect.objectContaining({
        tag: "meta",
        attrs: expect.objectContaining({
          "http-equiv": "Content-Security-Policy",
          content: PACKAGED_RENDERER_CSP,
        }),
      }),
    ])
  })

  test("injects the looser policy in development mode", () => {
    const plugin = createElectronRenderer("development").plugins?.find(
      (p) => (p as { name?: string }).name === "desktop-renderer-document-csp",
    ) as { transformIndexHtml?: { handler: () => Array<{ attrs: Record<string, string> }> } }
    const tags = plugin.transformIndexHtml!.handler()
    expect(tags[0].attrs.content).toBe(DEV_RENDERER_CSP)
  })
})
