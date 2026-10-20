import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { contentSecurityPolicy } from "../../content-security-policy"
import { MCP_APP_BOOTSTRAP, MCP_APP_BOOTSTRAP_HASH, MCP_APP_DOCUMENT_MESSAGE } from "./bootstrap"
import { mcpAppPolicy } from "./csp"
import { documentMessage, appFrameDocument } from "./document"

type Listener = (event: { source: unknown; data: unknown }) => void

function bootFrame() {
  const parent = { name: "host window" }
  const listeners = new Set<Listener>()
  const parsed: string[] = []
  const events: string[] = []
  const element = () => ({ attributes: [], childNodes: [], setAttribute: () => undefined, append: () => undefined })
  const fakeDocument = {
    documentElement: element(),
    head: element(),
    body: element(),
    dispatchEvent: (event: Event) => events.push(`document:${event.type}`),
  }
  class FakeParser {
    parseFromString(html: string) {
      parsed.push(html)
      return { ...fakeDocument, querySelectorAll: () => [], createComment: () => ({}) }
    }
  }
  const globals = {
    parent,
    addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
    DOMParser: FakeParser,
    document: fakeDocument,
    window: { dispatchEvent: (event: Event) => events.push(`window:${event.type}`) },
  }
  // oxlint-disable-next-line typescript-eslint/no-implied-eval
  new Function(...Object.keys(globals), MCP_APP_BOOTSTRAP)(...Object.values(globals))
  const post = (data: unknown, source: unknown = parent) => {
    for (const listener of listeners) listener({ source, data })
  }
  return { post, parsed, events, listeners }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test("the bootstrap hash is the sha256 of the bootstrap text, and the text cannot close its script element", () => {
  expect(MCP_APP_BOOTSTRAP_HASH).toBe(`sha256-${createHash("sha256").update(MCP_APP_BOOTSTRAP).digest("base64")}`)
  expect(MCP_APP_BOOTSTRAP.toLowerCase()).not.toContain("</script")
  expect(MCP_APP_BOOTSTRAP).toContain(`"${MCP_APP_DOCUMENT_MESSAGE}"`)
})

test("the app's own policy and the frame's policy both allow the bootstrap and blob scripts, never inline ones", () => {
  const appScripts = contentSecurityPolicy({ servers: [], frames: "none" }).split("; ").find((entry) => entry.startsWith("script-src "))
  expect(appScripts).toBe(`script-src 'self' 'wasm-unsafe-eval' blob: '${MCP_APP_BOOTSTRAP_HASH}'`)
  const frameScripts = mcpAppPolicy({ resourceDomains: ["https://cdn.example.com"] }).split("; ").find((entry) => entry.startsWith("script-src "))
  expect(frameScripts).toBe(`script-src '${MCP_APP_BOOTSTRAP_HASH}' blob: https://cdn.example.com`)
})

test("the frame document is the policy and the bootstrap, nothing of the app", () => {
  const document = appFrameDocument("default-src 'none'")
  expect(document).toBe(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><script>${MCP_APP_BOOTSTRAP}</script></head><body></body></html>`)
  expect(appFrameDocument(`a"b<c`)).toContain(`content="a&quot;b&lt;c"`)
  expect(documentMessage("<p>app</p>")).toEqual({ type: MCP_APP_DOCUMENT_MESSAGE, html: "<p>app</p>" })
})

test("the bootstrap takes one document, only from its parent, then fires DOMContentLoaded and load", async () => {
  const frame = bootFrame()
  frame.post(documentMessage("<p>from elsewhere</p>"), { name: "another window" })
  frame.post({ type: "something-else", html: "<p>x</p>" })
  frame.post({ type: MCP_APP_DOCUMENT_MESSAGE, html: 42 })
  frame.post(null)
  expect(frame.parsed).toEqual([])
  frame.post(documentMessage("<p>app</p>"))
  frame.post(documentMessage("<p>second</p>"))
  await settle()
  expect(frame.parsed).toEqual(["<p>app</p>"])
  expect(frame.listeners.size).toBe(0)
  expect(frame.events).toEqual(["document:DOMContentLoaded", "window:load"])
})
