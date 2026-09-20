import { beforeEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { sessionConfigRawQueryKey } from "../../store/session-config-selection"
import { createSubmitTransportAdapter, signedSubmitWorkspaceId, submitWorkspaceBacking } from "./submit-transport"

const CODEX = { kind: "native", harnessId: "codex" } as const
const EXTERNAL_OPENCODE = { kind: "connection", connectionId: "external-opencode" } as const

describe("submit transport adapter", () => {
  const calls: Array<{ url: string; method: string; body?: string | null }> = []
  const toasts: Array<{ title: string; description?: string; variant?: "error" }> = []

  beforeEach(() => {
    calls.length = 0
    toasts.length = 0
    queryClient.clear()
  })

  const createAdapter = (
    response: Response | ((input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>) = (
      _input,
      init,
    ) => Response.json(typeof init?.body === "string" ? JSON.parse(init.body) : null),
  ) =>
    createSubmitTransportAdapter({
      serverUrl: () => "https://control.example",
      signedControlPlane: () => false,
      projects: () => [],
      workspaceId: () => undefined,
      hostKind: () => undefined,
      request: fetch,
      localRequest: async (input, init) => {
        const request = input instanceof Request ? input : new Request(String(input), init)
        calls.push({
          url: request.url,
          method: request.method,
          body: typeof init?.body === "string" ? init.body : null,
        })
        return typeof response === "function" ? response(input, init) : response.clone()
      },
      createClient: () => ({
        session: {
          get: async () => ({}),
          prompt: async () => ({}),
          promptAsync: async () => ({}),
        },
      }),
      showToast: (toast) => toasts.push(toast),
      formatError: (err) => (err instanceof Error ? err.message : "Request failed"),
      text: {
        configSaveFailedTitle: "Could not save session config",
      },
    })

  test("derives cache refresh backing from canonical signed workspace identity", () => {
    expect(
      submitWorkspaceBacking({
        workspaceId: "ws_explicit",
        hostKind: "machine",
      }),
    ).toEqual({ workspaceId: "ws_explicit", kind: "machine" })

    expect(
      submitWorkspaceBacking({
        sessionRef: {
          sessionId: "ses_1",
          host: "workspace",
          toolSandbox: {
            kind: "workspace",
            workspaceId: "ws_ref",
            hosting: "provisioner",
            hostId: "host_1",
          },
        },
        workspaceId: "ws_explicit",
        hostKind: "machine",
      }),
    ).toEqual({ workspaceId: "ws_ref", kind: "provisioner", hostId: "host_1" })
  })

  test("does not synthesize cache refresh backing for local or partial identity", () => {
    expect(
      submitWorkspaceBacking({
        sessionRef: {
          sessionId: "ses_local",
          host: "workspace",
          toolSandbox: { kind: "local", cwd: "/repo/main" },
        },
      }),
    ).toBeUndefined()
    expect(submitWorkspaceBacking({ workspaceId: "ws_partial" })).toBeUndefined()
    expect(submitWorkspaceBacking({ hostKind: "provisioner" })).toBeUndefined()
  })

  test("session config PATCH is query-owned and dedupes identical payloads", async () => {
    const adapter = createAdapter()

    await adapter.saveSessionConfig({
      sessionID: "session-1",
      directory: "/repo/main",
      harnessType: EXTERNAL_OPENCODE,
      agent: "review",
      model: { providerID: "provider", modelID: "model" },
    })
    await adapter.saveSessionConfig({
      sessionID: "session-1",
      directory: "/repo/main",
      harnessType: EXTERNAL_OPENCODE,
      agent: "review",
      model: { providerID: "provider", modelID: "model" },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      url: "https://control.example/session/session-1/config?directory=%2Frepo%2Fmain",
      method: "PATCH",
    })
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      harness: { id: "external-opencode", access: "connection" },
      agent: "review",
      model: { providerID: "provider", modelID: "model" },
    })
    expect(
      queryClient.getQueryData(
        sessionConfigRawQueryKey({
          sessionID: "session-1",
          directory: "/repo/main",
          serverUrl: "https://control.example",
        }),
      ),
    ).toEqual(JSON.parse(calls[0]?.body ?? "{}"))
  })

  test("session config PATCH sends the canonical harness identity for every harness key", async () => {
    const adapter = createAdapter()

    await adapter.saveSessionConfig({
      sessionID: "session-acp",
      directory: "/repo/main",
      harnessType: { kind: "connection", connectionId: "team-claude" },
      agent: "build",
      model: { providerID: "team-claude", modelID: "opus" },
    })
    await adapter.saveSessionConfig({
      sessionID: "session-sdk",
      directory: "/repo/main",
      harnessType: { kind: "native", harnessId: "claude" },
      agent: "build",
    })

    expect(calls.map((call) => JSON.parse(call.body ?? "{}").harness)).toEqual([
      { id: "team-claude", access: "connection" },
      { id: "claude", access: "native" },
    ])
  })

  test("session config dedupe matches the persisted native identity", async () => {
    const adapter = createAdapter()

    // Exactly what the runtime persists and `readSessionConfig` caches.
    queryClient.setQueryData(
      sessionConfigRawQueryKey({
        sessionID: "session-sdk",
        directory: "/repo/main",
        serverUrl: "https://control.example",
      }),
      {
        harness: { id: "claude", access: "native" },
        agent: "build",
        model: { providerID: "claude", modelID: "opus" },
      },
    )

    await adapter.saveSessionConfig({
      sessionID: "session-sdk",
      directory: "/repo/main",
      harnessType: { kind: "native", harnessId: "claude" },
      agent: "build",
      model: { providerID: "claude", modelID: "opus" },
    })

    expect(calls).toEqual([])

    // A real change still writes.
    await adapter.saveSessionConfig({
      sessionID: "session-sdk",
      directory: "/repo/main",
      harnessType: { kind: "native", harnessId: "claude" },
      agent: "plan",
      model: { providerID: "claude", modelID: "opus" },
    })

    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      harness: { id: "claude", access: "native" },
      agent: "plan",
      model: { providerID: "claude", modelID: "opus" },
    })
  })

  test("failed session config PATCH shows a toast and does not cache the payload", async () => {
    const adapter = createAdapter(() => {
      throw new Error("offline")
    })

    await adapter.saveSessionConfig({
      sessionID: "session-failed",
      directory: "/repo/main",
      harnessType: CODEX,
      agent: "build",
    })

    expect(calls).toHaveLength(1)
    expect(
      queryClient.getQueryData(
        sessionConfigRawQueryKey({
          sessionID: "session-failed",
          directory: "/repo/main",
          serverUrl: "https://control.example",
        }),
      ),
    ).toBeUndefined()
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
      harnessType: CODEX,
      agent: "build",
    })

    expect(calls).toHaveLength(1)
    expect(
      queryClient.getQueryData(
        sessionConfigRawQueryKey({
          sessionID: "session-http-failed",
          directory: "/repo/main",
          serverUrl: "https://control.example",
        }),
      ),
    ).toBeUndefined()
    expect(toasts).toEqual([
      {
        title: "Could not save session config",
        description: "server error",
        variant: "error",
      },
    ])
  })

  test("native Pi config reads use the machine runtime", async () => {
    const centralCalls: string[] = []
    const adapter = createSubmitTransportAdapter({
      serverUrl: () => "http://127.0.0.1:3001",
      signedControlPlane: () => false,
      projects: () => [],
      workspaceId: () => "ws_1",
      hostKind: () => undefined,
      sessionRef: () => ({
        sessionId: "session-central",
        host: "workspace",
        workspaceId: "ws_1",
        toolSandbox: { kind: "local", cwd: "/repo/main" },
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
      createClient: () => ({
        session: {
          get: async () => ({}),
          prompt: async () => ({}),
          promptAsync: async () => ({}),
        },
      }),
      showToast: (toast) => toasts.push(toast),
      formatError: (err) => (err instanceof Error ? err.message : "Request failed"),
      text: { configSaveFailedTitle: "Could not save session config" },
    })

    await expect(
      adapter.readSessionConfig({
        sessionID: "session-central",
        directory: "/repo/main",
      }),
    ).resolves.toMatchObject({ harness: { id: "pi" } })
    expect(centralCalls).toEqual([
      "GET http://127.0.0.1:3001/workspaces/ws_1/session/session-central/config",
    ])
    expect(toasts).toEqual([])
  })

  test("explicit workspace identity routes filesystem sessions through the workspace runtime", async () => {
    const runtimeCalls: string[] = []
    const adapter = createSubmitTransportAdapter({
      serverUrl: () => "http://127.0.0.1:3001",
      signedControlPlane: () => false,
      projects: () => [],
      workspaceId: () => "ws_1",
      hostKind: () => "machine",
      request: async (input, init) => {
        const request = input instanceof Request ? input : new Request(String(input), init)
        runtimeCalls.push(`${request.method} ${request.url}`)
        return Response.json({ harness: { id: "external-opencode", access: "connection" } })
      },
      localRequest: async () => {
        throw new Error("filesystem workspace request bypassed the workspace runtime")
      },
      createClient: () => ({
        session: {
          get: async () => ({}),
          prompt: async () => ({}),
          promptAsync: async () => ({}),
        },
      }),
      showToast: (toast) => toasts.push(toast),
      formatError: (err) => (err instanceof Error ? err.message : "Request failed"),
      text: { configSaveFailedTitle: "Could not save session config" },
    })

    await expect(
      adapter.readSessionConfig({
        sessionID: "session-workspace",
        directory: "/repo/main",
      }),
    ).resolves.toMatchObject({ harness: { id: "external-opencode", access: "connection" } })
    expect(runtimeCalls).toEqual([
      "GET http://127.0.0.1:3001/workspaces/ws_1/session/session-workspace/config",
    ])
    expect(toasts).toEqual([])
  })

  test("signed loopback workspace sessions use the relay instead of bare runtime paths", async () => {
    const runtimeCalls: string[] = []
    const adapter = createSubmitTransportAdapter({
      serverUrl: () => "http://127.0.0.1:4527",
      signedControlPlane: () => true,
      projects: () => [],
      workspaceId: () => "ws_signed",
      hostKind: () => "machine",
      request: async (input, init) => {
        const request = input instanceof Request ? input : new Request(String(input), init)
        runtimeCalls.push(`${request.method} ${request.url}`)
        if (new URL(request.url).pathname === "/api/workspace/ws_signed/connection") {
          return Response.json({
            backing: "cloud-vm",
            sessionAuthority: "managed-private",
            workspaceId: "ws_signed",
            role: "owner",
            relayUrl: "https://relay.test",
            runtimeAccessToken: "rat_signed",
            tokenExpiresAt: Date.now() + 120_000,
          })
        }
        return Response.json({ harness: { id: "external-opencode", access: "connection" } })
      },
      localRequest: async () => {
        throw new Error("signed workspace request bypassed the relay")
      },
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
      formatError: (err) => (err instanceof Error ? err.message : "Request failed"),
      text: { configSaveFailedTitle: "Could not save session config" },
    })

    await expect(
      adapter.readSessionConfig({
        sessionID: "session-signed",
        directory: "/repo/main",
      }),
    ).resolves.toMatchObject({ harness: { id: "external-opencode", access: "connection" } })

    const promptClient = adapter.createRuntimePromptClient({
      signedControlPlane: true,
      sessionDirectory: "/repo/main",
      sessionRef: {
        sessionId: "session-signed",
        host: "workspace",
        cwd: "/repo/main",
        toolSandbox: { kind: "local", cwd: "/repo/main" },
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
    await adapter.sessionClient("/repo/main", EXTERNAL_OPENCODE).session.status()

    expect(runtimeCalls).toEqual([
      "GET http://127.0.0.1:4527/api/workspace/ws_signed/connection",
      "GET https://relay.test/workspaces/ws_signed/session/session-signed/config",
      "POST https://relay.test/workspaces/ws_signed/session/session-signed/prompt_async",
      "GET https://relay.test/workspaces/ws_signed/session/status?connectionId=external-opencode",
    ])
  })
  test("the serving deployment's own declaration decides whether a loopback submit reserves", () => {
    // All four rows reach the SAME loopback address with the same build flags.
    // Only the catalog row differs, because only the serving process knows how
    // it composed its runtimes:
    //  - signed self-hosted: embedded issuer on localhost, `POST /session`
    //    answers `session_reservation_required`;
    //  - test-user e2e backend and the unsigned local product: no issuer, and
    //    `/api/control/session-registrations/reserve` answers 401;
    //  - a server that declared nothing: not a reason to reserve.
    const catalog = (sessionAuthority?: string) => [{
      id: "prj_1",
      worktree: "/repo/main",
      workspaces: {
        "/repo/main": {
          id: "ws_local",
          kind: "local",
          directory: "/repo/main",
          ...(sessionAuthority ? { session_authority: sessionAuthority } : {}),
        },
      },
    }]
    const adapterFor = (sessionAuthority?: string) => createSubmitTransportAdapter({
      serverUrl: () => "https://localhost:5178",
      signedControlPlane: () => false,
      projects: () => catalog(sessionAuthority),
      workspaceId: () => undefined,
      hostKind: () => undefined,
      request: fetch,
      localRequest: fetch,
      createClient: () => ({ session: { get: async () => ({}), prompt: async () => ({}), promptAsync: async () => ({}) } }),
      showToast: () => {},
      formatError: () => "Request failed",
      text: { configSaveFailedTitle: "Could not save session config" },
    })

    const signed = adapterFor("managed-private")
    expect(signed.usesLoopbackWorkspaceBridge("/repo/main")).toBe(true)
    expect(signed.usesSignedControlPlane("/repo/main")).toBe(false)
    expect(signed.usesManagedSessionRegistration("/repo/main")).toBe(true)

    expect(adapterFor("local").usesManagedSessionRegistration("/repo/main")).toBe(false)
    expect(adapterFor().usesManagedSessionRegistration("/repo/main")).toBe(false)
  })

  test("the resolve body the daemon writes still names a relay workspace for the session request", async () => {
    const urls: string[] = []
    const request: typeof fetch = async (target) => {
      const url = new URL(target instanceof Request ? target.url : String(target))
      urls.push(`${url.pathname}${url.search}`)
      if (url.pathname.endsWith("/api/workspace/resolve")) {
        // The word the daemon's own store writes, not the app's host kind.
        return Response.json({ workspaceId: "ws_c", kind: "cloud", directory: "/repo/relay" })
      }
      if (url.pathname === "/api/workspace/ws_c/connection") {
        return new Response("connection denied", { status: 403 })
      }
      return Response.json({}, { status: 200, headers: { "content-type": "application/json" } })
    }
    const adapter = createSubmitTransportAdapter({
      serverUrl: () => "https://control.example",
      signedControlPlane: () => true,
      projects: () => [],
      workspaceId: () => undefined,
      hostKind: () => undefined,
      request,
      localRequest: request,
      createClient: () => ({
        session: { get: async () => ({}), prompt: async () => ({}), promptAsync: async () => ({}) },
      }),
      showToast: (toast) => toasts.push(toast),
      formatError: (err) => (err instanceof Error ? err.message : "Request failed"),
      text: { configSaveFailedTitle: "Could not save session config" },
    })
    await adapter.readSessionConfig({ sessionID: "ses_1", directory: "/repo/relay" }).catch(() => undefined)
    expect(urls).toContain("/api/workspace/ws_c/connection")
  })

  test("the reservation workspace id falls back to the project catalog row for a locally served workspace", () => {
    const projects = [{
      id: "prj_1",
      worktree: "/repo/main",
      workspaces: {
        "/repo/main": { id: "ws_local", kind: "local", directory: "/repo/main" },
      },
    }]
    expect(signedSubmitWorkspaceId(undefined, "/repo/main", projects)).toBe("ws_local")
    expect(signedSubmitWorkspaceId("ws_route", "/repo/main", projects)).toBe("ws_route")
    expect(signedSubmitWorkspaceId(undefined, "/repo/other", projects)).toBeUndefined()
    expect(signedSubmitWorkspaceId(undefined, "/repo/main")).toBeUndefined()
  })
})
