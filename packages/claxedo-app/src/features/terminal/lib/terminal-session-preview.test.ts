import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import {
  aliasTerminalSessionPreview,
  cachedTerminalSessionPreview,
  loadTerminalSessionPreview,
} from "./terminal-session-preview"

afterEach(() => {
  queryClient.clear()
})

describe("terminal session preview aliases", () => {
  test("loadTerminalSessionPreview coalesces duplicate terminal preview requests", async () => {
    let calls = 0
    const request = () => {
      calls++
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            terminalId: "pty-shared",
            session: {
              terminalId: "pty-shared",
              provider: "opencode",
              sessionId: "sess-shared",
              updatedAt: Date.now(),
            },
          }),
        ),
      )
    }

    const first = loadTerminalSessionPreview("http://localhost:3011", "pty-shared", request)
    const second = loadTerminalSessionPreview("http://localhost:3011", "pty-shared", request)

    expect((await Promise.all([first, second])).map((item) => item?.sessionId)).toEqual(["sess-shared", "sess-shared"])
    expect((await loadTerminalSessionPreview("http://localhost:3011", "pty-shared", request))?.sessionId).toBe(
      "sess-shared",
    )
    expect(cachedTerminalSessionPreview("http://localhost:3011", "pty-shared")?.sessionId).toBe("sess-shared")
    expect(calls).toBe(1)
  })

  test("serves the second load from the Query response cache without refetching", async () => {
    // The response cache lives in the shared Query client (not a module Map):
    // once loaded, a subsequent load for the same target returns the cached
    // value with no new request, and the synchronous cache reader agrees.
    let calls = 0
    const request = (() => {
      calls += 1
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            terminalId: "pty-cached",
            session: { terminalId: "pty-cached", sessionId: "sess-cached", updatedAt: Date.now() },
          }),
        ),
      )
    }) as typeof fetch

    const loaded = await loadTerminalSessionPreview("http://localhost:3020", "pty-cached", request)
    expect(loaded?.sessionId).toBe("sess-cached")

    const again = await loadTerminalSessionPreview("http://localhost:3020", "pty-cached", request)
    expect(again?.sessionId).toBe("sess-cached")
    expect(cachedTerminalSessionPreview("http://localhost:3020", "pty-cached")?.sessionId).toBe("sess-cached")
    expect(calls).toBe(1)
  })

  test("loadTerminalSessionPreview follows replacement terminal ids", async () => {
    aliasTerminalSessionPreview("pty-old", "pty-new")

    let seen = ""
    const out = await loadTerminalSessionPreview("http://localhost:3001", "pty-old", (input) => {
      seen = String(input)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            terminalId: "pty-new",
            session: {
              terminalId: "pty-new",
              provider: "opencode",
              sessionId: "sess-1",
              updatedAt: Date.now(),
            },
          }),
        ),
      )
    })

    expect(seen).toContain("terminalId=pty-new")
    expect(out?.terminalId).toBe("pty-new")
    expect(out?.sessionId).toBe("sess-1")
  })

  test("loadTerminalSessionPreview treats empty session payload as no preview", async () => {
    const out = await loadTerminalSessionPreview("http://localhost:3001", "pty-empty", () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            source: "none",
            terminalId: "pty-empty",
            session: null,
          }),
        ),
      ),
    )

    expect(out).toBeNull()
  })

  test("loadTerminalSessionPreview preserves the session tab id", async () => {
    const out = await loadTerminalSessionPreview("http://localhost:3012", "pty-tab", () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            terminalId: "pty-tab",
            session: {
              terminalId: "pty-tab",
              tabId: "tab-1",
              provider: "opencode",
              sessionId: "sess-tab",
              updatedAt: Date.now(),
            },
          }),
        ),
      ),
    )

    expect(out?.tabId).toBe("tab-1")
  })

  test("loadTerminalSessionPreview scopes local workspace previews by directory", async () => {
    let seen = ""
    const out = await loadTerminalSessionPreview("http://server.test", "pty-local", {
      directory: "/Users/example/project",
      request: ((input) => {
        seen = String(input)
        return Promise.resolve(
          Response.json({
            success: true,
            source: "none",
            terminalId: "pty-local",
            session: null,
          }),
        )
      }) as typeof fetch,
      resolveWorkspaceRuntime: async () => ({
        kind: "local",
      }),
    })

    expect(out).toBeNull()
    expect(seen).toBe(
      "http://server.test/api/wr/hook/terminal-session?terminalId=pty-local&directory=%2FUsers%2Fexample%2Fproject",
    )
  })

  test("loadTerminalSessionPreview routes cloud workspace previews through Workspace Relay", async () => {
    const seen: Array<{ url: string; method: string; authorization: string | null }> = []
    const request = (async (input, init) => {
      const req = new Request(String(input), init)
      seen.push({
        url: req.url,
        method: req.method,
        authorization: req.headers.get("Authorization"),
      })

      if (req.url === "http://server.test/api/workspace/ws_1/connection") {
        return Response.json({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_1",
          relayUrl: "https://relay.test",
          runtimeAccessToken: "rat_1",
          role: "editor",
          tokenExpiresAt: Date.now() + 120_000,
        })
      }

      if (req.url === "https://relay.test/workspaces/ws_1/api/wr/hook/terminal-session?terminalId=pty-cloud") {
        return Response.json({
          success: true,
          terminalId: "pty-cloud",
          session: {
            terminalId: "pty-cloud",
            provider: "opencode",
            sessionId: "sess-cloud",
            updatedAt: Date.now(),
          },
        })
      }

      throw new Error(`Unexpected request: ${req.method} ${req.url}`)
    }) as typeof fetch

    const out = await loadTerminalSessionPreview("http://server.test", "pty-cloud", {
      directory: "/workspace",
      request,
      resolveWorkspaceRuntime: async () => ({
        kind: "cloud",
        workspaceId: "ws_1",
      }),
    })

    expect(out?.sessionId).toBe("sess-cloud")
    expect(seen.map((item) => `${item.method} ${item.url}`)).toEqual([
      "GET http://server.test/api/workspace/ws_1/connection",
      "GET https://relay.test/workspaces/ws_1/api/wr/hook/terminal-session?terminalId=pty-cloud",
    ])
    expect(seen[1]?.authorization).toBe("Bearer rat_1")
  })

  test("loadTerminalSessionPreview keeps loopback workspace previews on the local workspace proxy", async () => {
    const seen: string[] = []
    const out = await loadTerminalSessionPreview("http://127.0.0.1:3001", "pty-cloud-local", {
      directory: "/workspace",
      request: ((input, init) => {
        const req = new Request(String(input), init)
        seen.push(`${req.method} ${req.url} ${req.headers.get("x-opencode-directory") ?? ""}`.trim())
        if (
          req.url ===
          "http://127.0.0.1:3001/workspaces/ws_local/api/wr/hook/terminal-session?terminalId=pty-cloud-local"
        ) {
          return Promise.resolve(
            Response.json({
              success: true,
              terminalId: "pty-cloud-local",
              session: {
                terminalId: "pty-cloud-local",
                provider: "opencode",
                sessionId: "sess-cloud-local",
                updatedAt: Date.now(),
              },
            }),
          )
        }
        throw new Error(`Unexpected request: ${req.method} ${req.url}`)
      }) as typeof fetch,
      resolveWorkspaceRuntime: async () => ({
        kind: "cloud",
        workspaceId: "ws_local",
      }),
    })

    expect(out?.sessionId).toBe("sess-cloud-local")
    expect(seen).toEqual([
      "GET http://127.0.0.1:3001/workspaces/ws_local/api/wr/hook/terminal-session?terminalId=pty-cloud-local workspace:ws_local",
    ])
  })
})
