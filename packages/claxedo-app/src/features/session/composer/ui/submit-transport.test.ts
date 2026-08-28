import { beforeEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { sessionConfigRawQueryKey } from "../../store/session-config-selection"
import { createSubmitTransportAdapter, submitWorkspaceBacking } from "./submit-transport"

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

  test("derives cache refresh backing from canonical signed workspace identity", () => {
    expect(submitWorkspaceBacking({
      workspaceId: "ws_explicit",
      workspaceKind: "user-hosted",
    })).toEqual({ workspaceId: "ws_explicit", kind: "user-hosted" })

    expect(submitWorkspaceBacking({
      sessionRef: {
        sessionId: "ses_1",
        host: "workspace",
        toolSandbox: {
          kind: "workspace",
          workspaceId: "ws_ref",
          hosting: "cloud",
          hostId: "host_1",
        },
      },
      workspaceId: "ws_explicit",
      workspaceKind: "user-hosted",
    })).toEqual({ workspaceId: "ws_ref", kind: "cloud", hostId: "host_1" })
  })

  test("does not synthesize cache refresh backing for local or partial identity", () => {
    expect(submitWorkspaceBacking({
      sessionRef: {
        sessionId: "ses_local",
        host: "workspace",
        toolSandbox: { kind: "local", cwd: "/repo/main" },
      },
    })).toBeUndefined()
    expect(submitWorkspaceBacking({ workspaceId: "ws_partial" })).toBeUndefined()
    expect(submitWorkspaceBacking({ workspaceKind: "cloud" })).toBeUndefined()
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
    expect(queryClient.getQueryData(sessionConfigRawQueryKey({
      sessionID: "session-1",
      directory: "/repo/main",
      serverUrl: "https://control.example",
    }))).toEqual(JSON.parse(calls[0]?.body ?? "{}"))
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
    expect(queryClient.getQueryData(sessionConfigRawQueryKey({
      sessionID: "session-failed",
      directory: "/repo/main",
      serverUrl: "https://control.example",
    }))).toBeUndefined()
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
    expect(queryClient.getQueryData(sessionConfigRawQueryKey({
      sessionID: "session-http-failed",
      directory: "/repo/main",
      serverUrl: "https://control.example",
    }))).toBeUndefined()
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

  test("explicit workspace identity routes filesystem sessions through the workspace runtime", async () => {
    const runtimeCalls: string[] = []
    const adapter = createSubmitTransportAdapter({
      serverUrl: () => "http://127.0.0.1:3001",
      signedControlPlane: () => false,
      workspaceId: () => "ws_1",
      workspaceKind: () => "user-hosted",
      request: async (input, init) => {
        const request = input instanceof Request ? input : new Request(String(input), init)
        runtimeCalls.push(`${request.method} ${request.url}`)
        return Response.json({ harness: { type: "opencode" } })
      },
      localRequest: async () => {
        throw new Error("filesystem workspace request bypassed the workspace runtime")
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
      text: { configSaveFailedTitle: "Could not save session config" },
    })

    await expect(adapter.readSessionConfig({
      sessionID: "session-workspace",
      directory: "/repo/main",
      harnessType: "opencode",
    })).resolves.toMatchObject({ harness: { type: "opencode" } })
    expect(runtimeCalls).toEqual([
      "GET http://127.0.0.1:3001/workspaces/ws_1/session/session-workspace/config?harness=opencode",
    ])
    expect(toasts).toEqual([])
  })

  test("signed loopback workspace sessions use the relay instead of bare runtime paths", async () => {
    const runtimeCalls: string[] = []
    const adapter = createSubmitTransportAdapter({
      serverUrl: () => "http://127.0.0.1:4527",
      signedControlPlane: () => true,
      workspaceId: () => "ws_signed",
      workspaceKind: () => "user-hosted",
      request: async (input, init) => {
        const request = input instanceof Request ? input : new Request(String(input), init)
        runtimeCalls.push(`${request.method} ${request.url}`)
        if (new URL(request.url).pathname === "/api/workspace/ws_signed/connection") {
          return Response.json({
            access: "user-hosted",
            backing: "cloud-vm",
            workspaceId: "ws_signed",
            role: "owner",
            relayUrl: "https://relay.test",
            runtimeAccessToken: "rat_signed",
            tokenExpiresAt: Date.now() + 120_000,
          })
        }
        return Response.json({ harness: { type: "opencode" } })
      },
      localRequest: async () => {
        throw new Error("signed workspace request bypassed the relay")
      },
      config: undefined,
      createClient: ({ baseUrl, fetch: runtimeFetch, directory }) => ({
        session: {
          get: async () => ({}),
          prompt: async () => ({}),
          promptAsync: async () => ({}),
          status: async () => {
            const url = new URL("/session/status", baseUrl)
            url.searchParams.set("directory", directory)
            return { data: await (await runtimeFetch(url)).json() }
          },
        },
      }),
      showToast: (toast) => toasts.push(toast),
      formatError: (err) => err instanceof Error ? err.message : "Request failed",
      text: { configSaveFailedTitle: "Could not save session config" },
    })

    await expect(adapter.readSessionConfig({
      sessionID: "session-signed",
      directory: "/repo/main",
      harnessType: "opencode",
    })).resolves.toMatchObject({ harness: { type: "opencode" } })

    const promptClient = adapter.createRuntimePromptClient({
      signedControlPlane: true,
      sessionDirectory: "/repo/main",
      sessionRef: {
        sessionId: "session-signed",
        host: "workspace",
        cwd: "/repo/main",
        toolSandbox: { kind: "local", cwd: "/repo/main" },
      },
      opencodeClient: {
        session: {
          prompt: async () => ({}),
          promptAsync: async () => ({}),
        },
      },
    })
    await promptClient.session.promptAsync({
      sessionID: "session-signed",
      directory: "/repo/main",
      agent: "build",
      model: { providerID: "test", modelID: "test" },
      messageID: "message-signed",
      parts: [],
    })
    await adapter.sessionClient("/repo/main", "opencode").session.status()

    expect(runtimeCalls).toEqual([
      "GET http://127.0.0.1:4527/api/workspace/ws_signed/connection",
      "GET https://relay.test/workspaces/ws_signed/session/session-signed/config?harness=opencode",
      "POST https://relay.test/workspaces/ws_signed/session/session-signed/prompt_async",
      "GET https://relay.test/workspaces/ws_signed/session/status?harness=opencode",
    ])
  })
})
