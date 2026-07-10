import { beforeEach, describe, expect, test } from "bun:test"
import { queryClient } from "../../shared/query/query-client"
import {
  _resetSavedSessionConfigCacheForTest,
  createSubmitTransportAdapter,
  savedSessionConfigQueryKey,
} from "./submit-transport"

describe("submit transport adapter", () => {
  const calls: Array<{ url: string; method: string; body?: string | null }> = []
  const toasts: Array<{ title: string; description?: string; variant?: "error" }> = []

  beforeEach(() => {
    calls.length = 0
    toasts.length = 0
    _resetSavedSessionConfigCacheForTest()
  })

  const createAdapter = (response: Response | ((input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>) = new Response("{}", { status: 200 })) =>
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
    expect(queryClient.getQueryData(savedSessionConfigQueryKey("session-1"))).toBe(calls[0]?.body)
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
    expect(queryClient.getQueryData(savedSessionConfigQueryKey("session-failed"))).toBeUndefined()
    expect(toasts).toEqual([
      {
        title: "Could not save session config",
        description: "offline",
        variant: "error",
      },
    ])
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
    expect(queryClient.getQueryData(savedSessionConfigQueryKey("session-http-failed"))).toBeUndefined()
    expect(toasts).toEqual([
      {
        title: "Could not save session config",
        description: "server error",
        variant: "error",
      },
    ])
  })
})
