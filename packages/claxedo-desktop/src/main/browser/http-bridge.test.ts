import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { AgentAuditLog } from "./agent-audit-log"
import type { BrowserHandle } from "./handle"
import type { BrowserRegistry } from "./registry"
import { startDesktopHttpBridge, type BridgeHandle } from "./http-bridge"
import { __resetDesktopAuthForTests, DESKTOP_MCP_ORIGIN, DESKTOP_TOKEN_HEADER } from "./token"

/**
 * The bridge test stands up a real `node:http` listener against a tiny
 * fake registry. This lets us exercise auth, CSRF, method restrictions,
 * and the shape of each response without Electron.
 */

type StubHandle = {
  webContentsId: number
  agentAllowed: boolean
  getConsoleLogs: BrowserHandle["getConsoleLogs"]
  screenshot: BrowserHandle["screenshot"]
  evaluate: BrowserHandle["evaluate"]
  navigate: BrowserHandle["navigate"]
  webContents: unknown
}

function makeStubHandle(overrides: Partial<StubHandle> = {}): StubHandle {
  return {
    webContentsId: 1,
    agentAllowed: false,
    getConsoleLogs: () => [] as ReturnType<BrowserHandle["getConsoleLogs"]>,
    screenshot: async () => ({ ok: true as const, dataUrl: "data:image/png;base64,AA==", mimeType: "image/png" as const }),
    evaluate: async () => ({ ok: true as const, result: 42 }),
    navigate: async () => {},
    webContents: {
      getURL: () => "https://example.test/path",
      getTitle: () => "Example Title",
    },
    ...overrides,
  }
}

function makeStubRegistry(handles: Record<string, StubHandle>): BrowserRegistry {
  return {
    get: (paneId: string) => handles[paneId] as unknown as BrowserHandle | undefined,
    paneIds: () => Object.keys(handles),
    register: () => {
      throw new Error("not implemented in stub")
    },
    unregister: () => {},
    clear: () => {},
  } as unknown as BrowserRegistry
}

describe("http-bridge", () => {
  let bridge: BridgeHandle | undefined
  let auditLog: AgentAuditLog

  beforeEach(() => {
    __resetDesktopAuthForTests()
    auditLog = new AgentAuditLog()
  })

  afterEach(async () => {
    if (bridge) {
      await bridge.close()
      bridge = undefined
    }
    __resetDesktopAuthForTests()
  })

  const boot = async (handles: Record<string, StubHandle> = {}) => {
    const registry = makeStubRegistry(handles)
    bridge = await startDesktopHttpBridge({ registry, auditLog })
    return bridge
  }

  const headers = (override: Record<string, string> = {}) => ({
    [DESKTOP_TOKEN_HEADER]: bridge!.token,
    "Content-Type": "application/json",
    ...override,
  })

  test("binds to 127.0.0.1 loopback on an ephemeral port", async () => {
    await boot()
    expect(bridge!.url.startsWith("http://127.0.0.1:")).toBe(true)
    // Port should be assigned and non-zero after listen().
    expect(bridge!.port).toBeGreaterThan(0)
  })

  test("rejects missing token with 401", async () => {
    await boot()
    const res = await fetch(`${bridge!.url}/browser/tabs`)
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("missing-token")
  })

  test("rejects wrong token with 401", async () => {
    await boot()
    const res = await fetch(`${bridge!.url}/browser/tabs`, {
      headers: { [DESKTOP_TOKEN_HEADER]: "not-the-right-secret-aaaaaaaaa" },
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("bad-token")
  })

  test("rejects bad Origin with 403 even when token is valid", async () => {
    await boot()
    const res = await fetch(`${bridge!.url}/browser/tabs`, {
      headers: headers({ Origin: "https://malicious.example" }),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("bad-origin")
  })

  test("accepts synthetic MCP origin", async () => {
    await boot()
    const res = await fetch(`${bridge!.url}/browser/tabs`, {
      headers: headers({ Origin: DESKTOP_MCP_ORIGIN }),
    })
    expect(res.status).toBe(200)
  })

  test("accepts 'null' origin header (MCP stdio clients)", async () => {
    await boot()
    const res = await fetch(`${bridge!.url}/browser/tabs`, {
      headers: headers({ Origin: "null" }),
    })
    expect(res.status).toBe(200)
  })

  test("GET /browser/tabs lists registered panes", async () => {
    await boot({
      "pane-a": makeStubHandle({
        agentAllowed: true,
        webContents: { getURL: () => "https://a.test/", getTitle: () => "A" },
      }),
      "pane-b": makeStubHandle({
        agentAllowed: false,
        webContents: { getURL: () => "https://b.test/", getTitle: () => "B" },
      }),
    })

    const res = await fetch(`${bridge!.url}/browser/tabs`, { headers: headers() })
    const body = (await res.json()) as { tabs: Array<{ paneId: string; agentAllowed: boolean; title: string }> }
    expect(body.tabs).toHaveLength(2)
    const panes = body.tabs.reduce(
      (acc, tab) => {
        acc[tab.paneId] = tab
        return acc
      },
      {} as Record<string, (typeof body.tabs)[number]>,
    )
    expect(panes["pane-a"]?.agentAllowed).toBe(true)
    expect(panes["pane-a"]?.title).toBe("A")
    expect(panes["pane-b"]?.agentAllowed).toBe(false)
  })

  test("GET /browser/:paneId/screenshot refuses (method-not-allowed) — GETs can't mutate state", async () => {
    await boot({ "pane-a": makeStubHandle() })

    const res = await fetch(`${bridge!.url}/browser/pane-a/screenshot`, { headers: headers() })
    expect(res.status).toBe(405)
  })

  test("GET /browser/:paneId/navigate refuses (method-not-allowed)", async () => {
    await boot({ "pane-a": makeStubHandle() })

    const res = await fetch(`${bridge!.url}/browser/pane-a/navigate`, { headers: headers() })
    expect(res.status).toBe(405)
  })

  test("POST /browser/:paneId/navigate invokes handle.navigate and audits allowed", async () => {
    let navigated = ""
    await boot({
      "pane-a": makeStubHandle({
        navigate: async (url: string) => {
          navigated = url
        },
      }),
    })

    const res = await fetch(`${bridge!.url}/browser/pane-a/navigate`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ url: "https://example.test/next" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
    expect(navigated).toBe("https://example.test/next")
    const trail = auditLog.forPane("pane-a")
    expect(trail).toHaveLength(1)
    expect(trail[0]?.action).toBe("navigate")
    expect(trail[0]?.result).toBe("allowed")
  })

  test("POST /browser/:paneId/navigate rejects non-http schemes and audits the denial", async () => {
    await boot({ "pane-a": makeStubHandle() })
    const res = await fetch(`${bridge!.url}/browser/pane-a/navigate`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ url: "file:///etc/passwd" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; error?: { code: string } }
    expect(body.ok).toBe(false)
    expect(body.error?.code).toBe("bad-scheme")
    expect(auditLog.forPane("pane-a")[0]?.result).toBe("denied")
  })

  test("POST /browser/:paneId/evaluate refuses to exceed 256 KB request body", async () => {
    await boot({ "pane-a": makeStubHandle() })
    const huge = "A".repeat(300_000)
    const res = await fetch(`${bridge!.url}/browser/pane-a/evaluate`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ expression: huge }),
    })
    expect(res.status).toBe(400)
  })

  test("POST /browser/:paneId/screenshot returns too-large when image > 1 MB", async () => {
    const big = "A".repeat(2_000_000)
    await boot({
      "pane-a": makeStubHandle({
        screenshot: async () => ({
          ok: true as const,
          dataUrl: `data:image/png;base64,${big}`,
          mimeType: "image/png" as const,
        }),
      }),
    })

    const res = await fetch(`${bridge!.url}/browser/pane-a/screenshot`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; error?: { code: string } }
    expect(body.ok).toBe(false)
    expect(body.error?.code).toBe("too-large")
    expect(auditLog.forPane("pane-a")[0]?.result).toBe("denied")
    expect(auditLog.forPane("pane-a")[0]?.reason).toBe("image-too-large")
  })

  test("POST /browser/:paneId/screenshot passes through successful result and audits", async () => {
    await boot({ "pane-a": makeStubHandle() })
    const res = await fetch(`${bridge!.url}/browser/pane-a/screenshot`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; mimeType?: string }
    expect(body.ok).toBe(true)
    expect(body.mimeType).toBe("image/png")
    const trail = auditLog.forPane("pane-a")
    expect(trail[0]?.action).toBe("screenshot")
    expect(trail[0]?.result).toBe("allowed")
  })

  test("POST /browser/:paneId/evaluate surfaces eval-denied for panes without agentAllowed", async () => {
    await boot({
      "pane-a": makeStubHandle({
        evaluate: async () => ({
          ok: false as const,
          error: { code: "eval-denied" as const, message: "pane not opted in" },
        }),
      }),
    })
    const res = await fetch(`${bridge!.url}/browser/pane-a/evaluate`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ expression: "1+1" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; error?: { code: string } }
    expect(body.ok).toBe(false)
    expect(body.error?.code).toBe("eval-denied")
    expect(auditLog.forPane("pane-a")[0]?.reason).toBe("eval-denied")
  })

  test("GET /browser/:paneId/console returns handle console entries", async () => {
    await boot({
      "pane-a": makeStubHandle({
        getConsoleLogs: () => [
          {
            id: 1,
            time: 1000,
            level: "log",
            args: ["hello"],
            source: "console",
          },
        ],
      }),
    })

    const res = await fetch(`${bridge!.url}/browser/pane-a/console?limit=5`, { headers: headers() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: Array<{ args: string[] }> }
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0]?.args).toEqual(["hello"])
  })

  test("pane-not-found yields 404", async () => {
    await boot()
    const res = await fetch(`${bridge!.url}/browser/does-not-exist/console`, { headers: headers() })
    expect(res.status).toBe(404)
  })

  test("unknown route yields 404", async () => {
    await boot()
    const res = await fetch(`${bridge!.url}/does/not/exist`, { headers: headers() })
    expect(res.status).toBe(404)
  })

  test("GET /browser/:paneId/audit returns the per-pane trail", async () => {
    await boot({ "pane-a": makeStubHandle() })
    // Seed a navigate + a screenshot on pane-a
    await fetch(`${bridge!.url}/browser/pane-a/navigate`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ url: "https://example.test/" }),
    })
    await fetch(`${bridge!.url}/browser/pane-a/screenshot`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({}),
    })

    const res = await fetch(`${bridge!.url}/browser/pane-a/audit`, { headers: headers() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: Array<{ action: string }> }
    const actions = body.entries.map((e) => e.action)
    expect(actions).toContain("navigate")
    expect(actions).toContain("screenshot")
  })
})
