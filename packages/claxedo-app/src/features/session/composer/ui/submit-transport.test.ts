import { beforeEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { sessionConfigRawQueryKey } from "../../store/session-config-selection"
import { createSubmitTransportAdapter } from "./submit-transport"

describe("submit transport adapter", () => {
  const calls: Array<{ url: string; method: string; body?: string | null }> = []
  const toasts: Array<{ title: string; description?: string; variant?: "error" }> = []

  beforeEach(() => {
    calls.length = 0
    toasts.length = 0
    queryClient.clear()
  })

  const createAdapter = (response: Response | ((input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>) = ((_input, init) => Response.json(JSON.parse(String(init?.body))))) =>
    createSubmitTransportAdapter({
      serverUrl: () => "https://control.example",
      signedControlPlane: () => false,
      workspaceId: () => undefined,
      workspaceKind: () => undefined,
      request: fetch,
      localRequest: async (input, init) => {
        const request = input instanceof Request ? input : new Request(String(input), init)
        calls.push({
          url: request.url,
          method: request.method,
          body: init?.body ? String(init.body) : null,
        })
        return typeof response === "function" ? response(input, init) : response.clone()
      },
      config: undefined,
      createClient: () => ({
        session: {
          get: async () => ({}),
          prompt: async () => ({}),
          promptAsync: async () => ({}),
        },
      }),
      showToast: (toast) => toasts.push(toast),
      formatError: (err) => err instanceof Error ? err.message : "Request failed",
      text: {
        configSaveFailedTitle: "Could not save session config",
      },
    })

  test("session config PATCH is query-owned and dedupes identical payloads", async () => {
    const adapter = createAdapter()

    await adapter.saveSessionConfig({
      sessionID: "session-1",
      directory: "/repo/main",
      harnessType: "opencode",
      agent: "review",
      model: { providerID: "provider", modelID: "model" },
    })
    await adapter.saveSessionConfig({
      sessionID: "session-1",
      directory: "/repo/main",
      harnessType: "opencode",
      agent: "review",
      model: { providerID: "provider", modelID: "model" },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      url: "https://control.example/session/session-1/config?directory=%2Frepo%2Fmain&harness=opencode",
      method: "PATCH",
    })
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      harness: { type: "opencode" },
      agent: "review",
      model: { providerID: "provider", modelID: "model" },
    })
    expect(queryClient.getQueryData(sessionConfigRawQueryKey("session-1"))).toEqual(JSON.parse(calls[0]?.body ?? "{}"))
  })

  test("failed session config PATCH shows a toast and does not cache the payload", async () => {
    const adapter = createAdapter(() => {
      throw new Error("offline")
    })

    await adapter.saveSessionConfig({
      sessionID: "session-failed",
      directory: "/repo/main",
      harnessType: "codex",
      agent: "build",
    })

    expect(calls).toHaveLength(1)
    expect(queryClient.getQueryData(sessionConfigRawQueryKey("session-failed"))).toBeUndefined()
    expect(toasts).toEqual([
      {
        title: "Could not save session config",
        description: "offline",
        variant: "error",
      },
    ])
  })

  test("authoritative session config persistence rejects before a new session is published", async () => {
    const adapter = createAdapter(() => new Response("server error", { status: 500 }))

    await expect(adapter.persistSessionConfig({
      sessionID: "session-created",
      directory: "/repo/main",
      harnessType: "claude-sdk",
      agent: "build",
      model: { providerID: "claude-sdk", modelID: "sonnet" },
    })).rejects.toThrow("server error")

    expect(calls).toHaveLength(1)
    expect(queryClient.getQueryData(sessionConfigRawQueryKey("session-created"))).toBeUndefined()
    expect(toasts).toEqual([])
  })

  test("authoritative session config persistence writes through a matching client cache", async () => {
    const adapter = createAdapter()
    const config = {
      harness: { type: "claude-sdk" },
      agent: "build",
      model: { providerID: "claude-sdk", modelID: "sonnet" },
    }
    queryClient.setQueryData(sessionConfigRawQueryKey("session-created-cached"), config)

    await adapter.persistSessionConfig({
      sessionID: "session-created-cached",
      directory: "/repo/main",
      harnessType: "claude-sdk",
      agent: "build",
      model: { providerID: "claude-sdk", modelID: "sonnet" },
    })

    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual(config)
  })

  test("session config PATCH resolving with a non-2xx response shows a toast and does not cache the payload", async () => {
    const adapter = createAdapter(() => new Response("server error", { status: 500 }))

    await adapter.saveSessionConfig({
      sessionID: "session-http-failed",
      directory: "/repo/main",
      harnessType: "codex",
      agent: "build",
    })

    expect(calls).toHaveLength(1)
    expect(queryClient.getQueryData(sessionConfigRawQueryKey("session-http-failed"))).toBeUndefined()
    expect(toasts).toEqual([
      {
        title: "Could not save session config",
        description: "server error",
        variant: "error",
      },
    ])
  })

  test("central session config reads use the authoritative control route", async () => {
    const centralCalls: string[] = []
    const adapter = createSubmitTransportAdapter({
      serverUrl: () => "http://127.0.0.1:3001",
      signedControlPlane: () => false,
      workspaceId: () => "ws_1",
      workspaceKind: () => undefined,
      sessionRef: () => ({
        sessionId: "session-central",
        host: "central",
        workspaceId: "ws_1",
        toolSandbox: { kind: "virtual" },
      }),
      request: async (input, init) => {
        const request = input instanceof Request ? input : new Request(String(input), init)
        centralCalls.push(`${request.method} ${request.url}`)
        return Response.json({
          harness: { id: "pi", access: "native" },
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
        })
      },
      localRequest: fetch,
      config: undefined,
      createClient: () => ({
        session: {
          get: async () => ({}),
          prompt: async () => ({}),
          promptAsync: async () => ({}),
        },
      }),
      showToast: (toast) => toasts.push(toast),
      formatError: (err) => err instanceof Error ? err.message : "Request failed",
      text: { configSaveFailedTitle: "Could not save session config" },
    })

    await expect(adapter.readSessionConfig({
      sessionID: "session-central",
      directory: "/repo/main",
      harnessType: "opencode",
    })).resolves.toMatchObject({ harness: { id: "pi" } })
    expect(centralCalls).toEqual([
      "GET http://127.0.0.1:3001/api/control/session/session-central/config?directory=%2Frepo%2Fmain&harness=opencode",
    ])
    expect(toasts).toEqual([])
  })
})
