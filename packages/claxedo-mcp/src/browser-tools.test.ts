/**
 * Unit tests for the browser_* MCP tools.
 *
 * Each tool's handler is exported explicitly so we can exercise the full
 * request/response path without registering against a real MCP server.
 * A fake `fetch` implementation simulates the desktop HTTP bridge.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { z } from "zod"

import {
  browserEvaluateJsSchema,
  browserGetConsoleLogsSchema,
  browserListTabsSchema,
  browserNavigateSchema,
  browserScreenshotSchema,
  extractBase64,
  handleBrowserEvaluateJs,
  handleBrowserGetConsoleLogs,
  handleBrowserListTabs,
  handleBrowserNavigate,
  handleBrowserScreenshot,
  registerBrowserTools,
} from "./browser-tools"
import { DESKTOP_MCP_ORIGIN, DESKTOP_TOKEN_HEADER } from "./desktop-request"

type FetchArgs = {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function makeFetch(responses: Record<string, { status: number; body: unknown }>): {
  fn: typeof fetch
  calls: FetchArgs[]
} {
  const calls: FetchArgs[] = []
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    const method = (init?.method ?? "GET").toUpperCase()
    const headersRec: Record<string, string> = {}
    if (init?.headers) {
      const h = new Headers(init.headers)
      h.forEach((v, k) => {
        headersRec[k.toLowerCase()] = v
      })
    }
    const body = typeof init?.body === "string" ? init.body : undefined
    calls.push({ url, method, headers: headersRec, body })
    // Find matching response by path suffix
    const match = Object.keys(responses).find((p) => url.endsWith(p))
    if (!match) {
      return new Response(`no route for ${url}`, { status: 404 })
    }
    const { status, body: respBody } = responses[match]!
    return new Response(JSON.stringify(respBody), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  }) as unknown as typeof fetch
  return { fn, calls }
}

const baseEnv: NodeJS.ProcessEnv = {
  CLAXEDO_DESKTOP_URL: "http://127.0.0.1:5555",
  CLAXEDO_DESKTOP_TOKEN: "test-token-abc123",
}

describe("browser-tools: input schemas", () => {
  test("browser_list_tabs has no required args", () => {
    const shape = z.object(browserListTabsSchema as Record<string, z.ZodTypeAny>)
    const parsed = shape.safeParse({})
    expect(parsed.success).toBe(true)
  })

  test("browser_screenshot requires pane_id; clip is optional", () => {
    const shape = z.object(browserScreenshotSchema as Record<string, z.ZodTypeAny>)
    expect(shape.safeParse({}).success).toBe(false)
    expect(shape.safeParse({ pane_id: "p1" }).success).toBe(true)
    expect(
      shape.safeParse({ pane_id: "p1", clip: { x: 0, y: 0, width: 10, height: 10 } }).success,
    ).toBe(true)
  })

  test("browser_get_console_logs pane_id required; level enum enforced", () => {
    const shape = z.object(browserGetConsoleLogsSchema as Record<string, z.ZodTypeAny>)
    expect(shape.safeParse({ pane_id: "p1" }).success).toBe(true)
    expect(shape.safeParse({ pane_id: "p1", level: "critical" }).success).toBe(false)
    expect(shape.safeParse({ pane_id: "p1", level: "error" }).success).toBe(true)
    expect(shape.safeParse({ pane_id: "p1", limit: 0 }).success).toBe(false)
  })

  test("browser_evaluate_js requires pane_id and expression with length bounds", () => {
    const shape = z.object(browserEvaluateJsSchema as Record<string, z.ZodTypeAny>)
    expect(shape.safeParse({ pane_id: "p1", expression: "1+1" }).success).toBe(true)
    expect(shape.safeParse({ pane_id: "p1" }).success).toBe(false)
    expect(shape.safeParse({ pane_id: "p1", expression: "" }).success).toBe(false)
    const huge = "a".repeat(300_000)
    expect(shape.safeParse({ pane_id: "p1", expression: huge }).success).toBe(false)
  })

  test("browser_navigate requires a URL", () => {
    const shape = z.object(browserNavigateSchema as Record<string, z.ZodTypeAny>)
    expect(shape.safeParse({ pane_id: "p1", url: "not-a-url" }).success).toBe(false)
    expect(shape.safeParse({ pane_id: "p1", url: "https://example.com" }).success).toBe(true)
  })
})

describe("browser-tools: desktop env gating", () => {
  test("returns legible isError when CLAXEDO_DESKTOP_URL is missing", async () => {
    const { fn } = makeFetch({})
    const result = await handleBrowserListTabs({ env: {}, fetchImpl: fn })
    expect(result.isError).toBe(true)
    const text = result.content[0]?.type === "text" ? result.content[0].text : ""
    expect(text).toContain("desktop app")
    expect(text).toContain("CLAXEDO_ENABLE_BROWSER_TAB")
  })

  test("returns legible isError when token is missing", async () => {
    const { fn } = makeFetch({})
    const result = await handleBrowserScreenshot(
      { pane_id: "p1" },
      { env: { CLAXEDO_DESKTOP_URL: "http://x" }, fetchImpl: fn },
    )
    expect(result.isError).toBe(true)
  })
})

describe("browser_list_tabs", () => {
  test("formats an empty list cleanly", async () => {
    const { fn, calls } = makeFetch({
      "/browser/tabs": { status: 200, body: { tabs: [] } },
    })
    const result = await handleBrowserListTabs({ env: baseEnv, fetchImpl: fn })
    expect(result.isError).toBeUndefined()
    const text = result.content[0]?.type === "text" ? result.content[0].text : ""
    expect(text).toContain("No browser tabs")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe("GET")
    expect(calls[0]?.headers[DESKTOP_TOKEN_HEADER]).toBe("test-token-abc123")
    expect(calls[0]?.headers["origin"]).toBe(DESKTOP_MCP_ORIGIN)
  })

  test("renders paneId + agentAllowed per tab", async () => {
    const { fn } = makeFetch({
      "/browser/tabs": {
        status: 200,
        body: {
          tabs: [
            { paneId: "pane-a", title: "A", currentUrl: "https://a/", agentAllowed: true },
            { paneId: "pane-b", title: "", currentUrl: "https://b/", agentAllowed: false },
          ],
        },
      },
    })
    const result = await handleBrowserListTabs({ env: baseEnv, fetchImpl: fn })
    const text = result.content[0]?.type === "text" ? result.content[0].text : ""
    expect(text).toContain("pane-a")
    expect(text).toContain("agentAllowed=true")
    expect(text).toContain("pane-b")
    expect(text).toContain("agentAllowed=false")
  })
})

describe("browser_screenshot", () => {
  test("returns inline image content for a successful bridge response", async () => {
    const { fn } = makeFetch({
      "/browser/pane-a/screenshot": {
        status: 200,
        body: { ok: true, dataUrl: "data:image/png;base64,AAAA", mimeType: "image/png" },
      },
    })
    const result = await handleBrowserScreenshot({ pane_id: "pane-a" }, { env: baseEnv, fetchImpl: fn })
    expect(result.isError).toBeUndefined()
    expect(result.content).toHaveLength(1)
    const part = result.content[0]
    expect(part?.type).toBe("image")
    if (part?.type === "image") {
      expect(part.mimeType).toBe("image/png")
      expect(part.data).toBe("AAAA")
    }
  })

  test("refuses to return images > 1 MB", async () => {
    const bigBase64 = "A".repeat(2_000_000)
    const { fn } = makeFetch({
      "/browser/pane-a/screenshot": {
        status: 200,
        body: { ok: true, dataUrl: `data:image/png;base64,${bigBase64}`, mimeType: "image/png" },
      },
    })
    const result = await handleBrowserScreenshot({ pane_id: "pane-a" }, { env: baseEnv, fetchImpl: fn })
    expect(result.isError).toBe(true)
    const text = result.content[0]?.type === "text" ? result.content[0].text : ""
    expect(text).toContain("exceeds")
  })

  test("surfaces bridge-reported errors", async () => {
    const { fn } = makeFetch({
      "/browser/pane-a/screenshot": {
        status: 200,
        body: { ok: false, error: { code: "no-page" } },
      },
    })
    const result = await handleBrowserScreenshot({ pane_id: "pane-a" }, { env: baseEnv, fetchImpl: fn })
    expect(result.isError).toBe(true)
    const text = result.content[0]?.type === "text" ? result.content[0].text : ""
    expect(text).toContain("no-page")
  })
})

describe("browser_get_console_logs", () => {
  test("sends since/level/limit as query params", async () => {
    const { fn, calls } = makeFetch({
      "/browser/pane-a/console?since=10&level=error&limit=25": {
        status: 200,
        body: {
          entries: [
            { id: 11, time: 1700_000_000_000, level: "error", args: ["boom"], source: "exception" },
          ],
        },
      },
    })
    const result = await handleBrowserGetConsoleLogs(
      { pane_id: "pane-a", since: 10, level: "error", limit: 25 },
      { env: baseEnv, fetchImpl: fn },
    )
    expect(result.isError).toBeUndefined()
    expect(calls[0]?.url).toContain("since=10")
    expect(calls[0]?.url).toContain("level=error")
    expect(calls[0]?.url).toContain("limit=25")
    const text = result.content[0]?.type === "text" ? result.content[0].text : ""
    expect(text).toContain("ERROR")
    expect(text).toContain("boom")
    expect(text).toContain("id=11")
  })

  test("empty ring buffer yields a legible message", async () => {
    const { fn } = makeFetch({
      "/browser/pane-a/console?limit=100": { status: 200, body: { entries: [] } },
    })
    const result = await handleBrowserGetConsoleLogs(
      { pane_id: "pane-a" },
      { env: baseEnv, fetchImpl: fn },
    )
    const text = result.content[0]?.type === "text" ? result.content[0].text : ""
    expect(text).toContain("No console entries")
  })
})

describe("browser_evaluate_js", () => {
  test("agentAllowed=false → legible {isError} denial", async () => {
    const { fn } = makeFetch({
      "/browser/pane-a/evaluate": {
        status: 200,
        body: { ok: false, error: { code: "eval-denied", message: "pane has not opted in" } },
      },
    })
    const result = await handleBrowserEvaluateJs(
      { pane_id: "pane-a", expression: "window.location.href" },
      { env: baseEnv, fetchImpl: fn },
    )
    expect(result.isError).toBe(true)
    const text = result.content[0]?.type === "text" ? result.content[0].text : ""
    expect(text).toContain("Allow agent to run JS")
    expect(text).toContain("pane-a")
  })

  test("script-error surfaces with code + message + stack", async () => {
    const { fn } = makeFetch({
      "/browser/pane-a/evaluate": {
        status: 200,
        body: {
          ok: false,
          error: { code: "script-error", message: "ReferenceError: x is not defined", stack: "at foo (x.js:1:1)" },
        },
      },
    })
    const result = await handleBrowserEvaluateJs(
      { pane_id: "pane-a", expression: "x + 1" },
      { env: baseEnv, fetchImpl: fn },
    )
    expect(result.isError).toBe(true)
    const text = result.content[0]?.type === "text" ? result.content[0].text : ""
    expect(text).toContain("script-error")
    expect(text).toContain("ReferenceError")
  })

  test("success serializes the returned value", async () => {
    const { fn } = makeFetch({
      "/browser/pane-a/evaluate": {
        status: 200,
        body: { ok: true, result: { answer: 42 } },
      },
    })
    const result = await handleBrowserEvaluateJs(
      { pane_id: "pane-a", expression: "({answer:42})" },
      { env: baseEnv, fetchImpl: fn },
    )
    expect(result.isError).toBeUndefined()
    const text = result.content[0]?.type === "text" ? result.content[0].text : ""
    expect(text).toContain("answer")
    expect(text).toContain("42")
  })
})

describe("browser_navigate", () => {
  test("successful navigate returns a confirmation line", async () => {
    const { fn, calls } = makeFetch({
      "/browser/pane-a/navigate": { status: 200, body: { ok: true } },
    })
    const result = await handleBrowserNavigate(
      { pane_id: "pane-a", url: "https://example.com" },
      { env: baseEnv, fetchImpl: fn },
    )
    expect(result.isError).toBeUndefined()
    const text = result.content[0]?.type === "text" ? result.content[0].text : ""
    expect(text).toContain("https://example.com")
    expect(calls[0]?.method).toBe("POST")
    const sent = JSON.parse(calls[0]?.body ?? "{}") as { url: string }
    expect(sent.url).toBe("https://example.com")
  })

  test("bridge-side bad-scheme is surfaced", async () => {
    const { fn } = makeFetch({
      "/browser/pane-a/navigate": {
        status: 200,
        body: { ok: false, error: { code: "bad-scheme", message: "scheme file: not allowed" } },
      },
    })
    const result = await handleBrowserNavigate(
      { pane_id: "pane-a", url: "https://example.com" },
      { env: baseEnv, fetchImpl: fn },
    )
    expect(result.isError).toBe(true)
    const text = result.content[0]?.type === "text" ? result.content[0].text : ""
    expect(text).toContain("bad-scheme")
  })
})

describe("network errors", () => {
  test("surfaces fetch exceptions as {isError}", async () => {
    const brokenFetch = (async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:5555")
    }) as unknown as typeof fetch
    const result = await handleBrowserListTabs({ env: baseEnv, fetchImpl: brokenFetch })
    expect(result.isError).toBe(true)
    const text = result.content[0]?.type === "text" ? result.content[0].text : ""
    expect(text).toContain("ECONNREFUSED")
  })

  test("non-2xx with JSON {error} message is surfaced verbatim", async () => {
    const { fn } = makeFetch({
      "/browser/tabs": { status: 401, body: { error: "missing-token" } },
    })
    const result = await handleBrowserListTabs({ env: baseEnv, fetchImpl: fn })
    expect(result.isError).toBe(true)
    const text = result.content[0]?.type === "text" ? result.content[0].text : ""
    expect(text).toContain("missing-token")
  })
})

describe("extractBase64", () => {
  test("extracts the trailing base64 from a data URL", () => {
    expect(extractBase64("data:image/png;base64,AAAA")).toBe("AAAA")
  })

  test("returns undefined for a malformed dataUrl", () => {
    expect(extractBase64("not-a-data-url")).toBeUndefined()
  })
})

describe("registerBrowserTools", () => {
  test("registers all five tools on the fake server", () => {
    type Registered = { name: string; description: string }
    const registered: Registered[] = []
    const fakeServer = {
      registerTool: (name: string, spec: { description: string; inputSchema: unknown }) => {
        registered.push({ name, description: spec.description })
      },
    }
    registerBrowserTools(fakeServer as unknown as Parameters<typeof registerBrowserTools>[0])
    const names = registered.map((r) => r.name)
    expect(names).toEqual([
      "browser_list_tabs",
      "browser_screenshot",
      "browser_get_console_logs",
      "browser_evaluate_js",
      "browser_navigate",
    ])
  })

  test("read-only mode omits browser JS evaluation and navigation", () => {
    type Registered = { name: string; description: string }
    const registered: Registered[] = []
    const fakeServer = {
      registerTool: (name: string, spec: { description: string; inputSchema: unknown }) => {
        registered.push({ name, description: spec.description })
      },
    }
    registerBrowserTools(fakeServer as unknown as Parameters<typeof registerBrowserTools>[0], { readOnly: true })
    expect(registered.map((r) => r.name)).toEqual([
      "browser_list_tabs",
      "browser_screenshot",
      "browser_get_console_logs",
    ])
  })
})
