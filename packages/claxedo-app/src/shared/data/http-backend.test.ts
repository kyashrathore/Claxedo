import { describe, expect, mock, test } from "bun:test"
import {
  createHttpSessionBackend,
  createHttpShellBackend,
  createHttpWorkspaceRuntimeBackend,
  createStoragePanePrefsBackend,
} from "./http-backend"

describe("http backend ports", () => {
  test("shell backend delegates to sdk-style clients", async () => {
    const backend = createHttpShellBackend({
      client: {
        project: {
          list: async () => ({ data: [{ id: "p1", worktree: "/tmp/p1" }] as any }),
        },
        provider: {
          list: async () => ({ data: { all: [{ id: "openai" }], connected: [], default: {} } as any }),
        },
        command: {
          list: async () => ({ data: [{ name: "build" }] as any }),
        },
      },
    })

    expect(await backend.listProjects()).toMatchObject([{ id: "p1" }])
    expect(await backend.listProviders()).toMatchObject({ all: [{ id: "openai" }] })
    expect(await backend.listCommands({ directory: "/tmp/p1" })).toMatchObject([{ name: "build" }])
  })

  test("runtime backend resolves and ensures through http", async () => {
    const request = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/api/workspace/resolve")) {
        return new Response(JSON.stringify({
          workspaceId: "ws_1",
          directory: "/tmp/ws",
          kind: "cloud",
          status: "stopped",
        }), { status: 200 })
      }
      expect(init?.method).toBe("POST")
      return new Response(JSON.stringify({
        workspaceId: "ws_1",
        directory: "/tmp/ws",
        kind: "cloud",
        status: "ready",
      }), { status: 200 })
    }) as unknown as typeof fetch

    const backend = createHttpWorkspaceRuntimeBackend({
      baseUrl: "http://runtime.test",
      request,
    })

    expect(await backend.resolveWorkspace({ directory: "/tmp/ws" })).toMatchObject({
      workspaceId: "ws_1",
      status: "stopped",
    })
    expect(await backend.ensureWorkspace({ directory: "/tmp/ws" })).toMatchObject({
      workspaceId: "ws_1",
      status: "ready",
    })
  })

  test("session backend splits upstream and claxedo transport", async () => {
    const calls: string[] = []
    const request = mock(async (input: string | URL | Request) => {
      calls.push(String(input))
      return new Response(JSON.stringify([{ info: { id: "msg_1" } }]), {
        status: 200,
        headers: { "x-next-cursor": "cursor_1" },
      })
    }) as unknown as typeof fetch

    const client = {
      get: mock(async () => ({ data: { id: "ses_1" } })),
      messages: mock(async () => ({ data: [], response: new Response(null) })),
      todo: mock(async () => ({ data: [] })),
    }

    const backend = createHttpSessionBackend({
      client,
      request,
      claxedoServerUrl: "http://claxedo.test",
    })

    expect(backend.usesScopedTransport("ses_1")).toBe(false)
    expect(backend.usesScopedTransport("uuid-1")).toBe(true)

    await backend.getSession({ directory: "/repo", sessionID: "ses_1" })
    await backend.listMessages({ directory: "/repo", sessionID: "uuid-1", limit: 8, before: "cursor_0" })

    expect(client.get).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([
      "http://claxedo.test/session/uuid-1/message?directory=%2Frepo&limit=8&before=cursor_0",
    ])
  })

  test("pane prefs backend reads and writes maps", () => {
    const state = new Map<string, string>()
    const backend = createStoragePanePrefsBackend({
      getItem: (key) => state.get(key) ?? null,
      setItem: (key, value) => {
        state.set(key, value)
      },
    })

    backend.setMap("runner", { "draft:1": "codex-acp" })
    expect(backend.getMap("runner")).toEqual({ "draft:1": "codex-acp" })
  })
})
