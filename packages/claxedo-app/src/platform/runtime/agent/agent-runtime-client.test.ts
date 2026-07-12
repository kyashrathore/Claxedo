import { afterEach, describe, expect, it } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { agentRuntimeWorkspaceTargetQueryKey, createAgentRuntimeClient } from "./agent-runtime-client"

function ok(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  })
}

describe("AgentRuntimeClient", () => {
  afterEach(() => {
    queryClient.clear()
    delete (globalThis as typeof globalThis & {
      __claxedoFastSessionSwitch?: unknown
    }).__claxedoFastSessionSwitch
  })

  it("constructs scoped local message requests through the session resource route", async () => {
    const seen: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001/",
      request: async (input) => {
        seen.push(String(input))
        return ok({ messages: [], maxEventOrdinal: 4 })
      },
    })

    const page = await client.getMessages({
      directory: "/repo/main",
      sessionID: "runtime-session-1",
      limit: 20,
      before: "cursor-1",
    })

    expect(seen).toEqual([
      "http://127.0.0.1:3001/session/runtime-session-1/message?directory=%2Frepo%2Fmain&limit=20&before=cursor-1",
    ])
    expect(page.maxEventOrdinal).toBe(4)
  })

  it("routes signed capability requests through workspace-runtime", async () => {
    const seen: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "https://control.example/",
      signedControlPlane: true,
      request: async (input) => {
        seen.push(String(input))
        if (String(input).includes("/api/workspace/ws_1/connection")) {
          return ok({
            access: "cloud",
            backing: "cloud-vm",
            workspaceId: "ws_1",
            relayUrl: "https://control.example",
            runtimeAccessToken: "runtime-token",
            role: "editor",
            tokenExpiresAt: Date.now() + 120_000,
          })
        }
        return ok({ transport: "claude-acp", abort: true })
      },
    })

    await client.getCapabilities({
      directory: "ws_1",
      sessionID: "runtime-session-1",
    })

    expect(seen).toEqual([
      "https://control.example/api/workspace/ws_1/connection",
      "https://control.example/workspaces/ws_1/session/runtime-session-1/capabilities",
    ])
  })

  it("keeps non-workspace legacy OpenCode sessions on the injected SDK client", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      request: async () => {
        throw new Error("request should not be used")
      },
      opencodeClient: {
        session: {
          async create() {
            calls.push("create")
            return { data: undefined }
          },
          async get() {
            calls.push("get")
            return { data: undefined }
          },
          async messages() {
            calls.push("messages")
            return { data: [], response: ok([], { headers: { "x-max-event-ordinal": "7" } }) }
          },
          async todo() {
            calls.push("todo")
            return { data: [] }
          },
          async prompt() {
            calls.push("prompt")
            return { data: undefined }
          },
          async promptAsync() {
            calls.push("promptAsync")
            return { data: undefined }
          },
          async abort() {
            calls.push("abort")
            return {}
          },
        },
      },
    })

    const page = await client.getMessages({
      directory: "opencode",
      sessionID: "ses_1",
      limit: 10,
    })

    expect(calls).toEqual(["messages"])
    expect(page.maxEventOrdinal).toBe(7)
  })

  it("routes filesystem OpenCode sessions through runtime transport for durable workspace state", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001/",
      request: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`)
        return ok([{ info: { id: "msg_1" }, parts: [] }], { headers: { "x-max-event-ordinal": "8" } })
      },
      opencodeClient: {
        session: {
          async messages() {
            throw new Error("opencode client should not be used")
          },
        },
      },
    })

    const page = await client.getMessages({
      directory: "/repo/main",
      sessionID: "ses_1",
      limit: 10,
    })

    expect(calls).toEqual([
      "GET http://127.0.0.1:3001/session/ses_1/message?directory=%2Frepo%2Fmain&limit=10",
    ])
    expect(page.maxEventOrdinal).toBe(8)
  })

  it("routes scoped sends through runtime session routes even when an OpenCode client is injected", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001/",
      request: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`)
        return ok({})
      },
      opencodeClient: {
        session: {
          async prompt() {
            calls.push("legacy prompt")
            return { data: undefined }
          },
          async promptAsync() {
            calls.push("legacy promptAsync")
            return { data: undefined }
          },
        },
      },
    })

    await client.sendMessage({
      mode: "async",
      directory: "/repo/main",
      sessionID: "runtime-session-1",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude" },
      messageID: "message-1",
      parts: [],
    })

    expect(calls).toEqual([
      "POST http://127.0.0.1:3001/session/runtime-session-1/prompt_async?directory=%2Frepo%2Fmain",
    ])
  })

  it("keeps local cwd-backed sessions on local runtime routes with cwd query scope", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001/",
      sessionRef: {
        sessionId: "runtime-session-1",
        host: "workspace",
        cwd: "/repo/main",
        toolSandbox: { kind: "local", cwd: "/repo/main" },
      },
      request: async (input, init) => {
        const url = new URL(String(input))
        if (url.pathname.startsWith("/workspaces/") || url.pathname.startsWith("/api/workspace")) {
          throw new Error(`local cwd session should stay on local session routes: ${url.pathname}`)
        }
        calls.push(`${init?.method ?? "GET"} ${String(input)}`)
        return ok({})
      },
    })

    await client.sendMessage({
      mode: "async",
      directory: "/repo/main",
      sessionID: "runtime-session-1",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude" },
      messageID: "message-1",
      parts: [],
    })

    expect(calls).toEqual([
      "POST http://127.0.0.1:3001/session/runtime-session-1/prompt_async?directory=%2Frepo%2Fmain",
    ])
  })

  it("chats through typed central placement without workspace or directory resolution", async () => {
    const calls: string[] = []
    const bodies: unknown[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001/",
      sessionRef: {
        sessionId: "ses_central",
        host: "central",
        toolSandbox: { kind: "virtual" },
      },
      request: async (input, init) => {
        const url = new URL(String(input))
        if (url.pathname.startsWith("/api/workspace") || url.pathname.startsWith("/api/control/sessions")) {
          throw new Error(`central chat should not resolve workspace scope: ${url.pathname}`)
        }
        calls.push(`${init?.method ?? "GET"} ${String(input)}`)
        if (init?.body) bodies.push(JSON.parse(String(init.body)))
        if (url.pathname.endsWith("/message")) return ok({ messages: [], maxEventOrdinal: 5 })
        return ok({})
      },
      opencodeClient: {
        session: {
          async prompt() {
            calls.push("legacy prompt")
            return { data: undefined }
          },
          async promptAsync() {
            calls.push("legacy promptAsync")
            return { data: undefined }
          },
        },
      },
    })

    await client.sendMessage({
      mode: "async",
      directory: "",
      sessionID: "ses_central",
      agent: "build",
      model: { providerID: "pi", modelID: "default" },
      messageID: "message-1",
      parts: [],
    })

    const page = await client.getMessages({
      directory: "",
      sessionID: "ses_central",
      limit: 20,
    })

    expect(calls).toEqual([
      "POST http://127.0.0.1:3001/session/ses_central/prompt_async?directory=",
      "GET http://127.0.0.1:3001/session/ses_central/message?directory=&limit=20",
    ])
    expect(bodies).toEqual([expect.objectContaining({
      directory: "",
      sessionID: "ses_central",
    })])
    expect(page.maxEventOrdinal).toBe(5)
  })

  it("uses explicit workspace backing without inspecting directory string shape", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001/",
      sessionRef: {
        sessionId: "runtime-session-1",
        host: "workspace",
        workspaceId: "ws_explicit",
        toolSandbox: {
          kind: "workspace",
          workspaceId: "ws_explicit",
          hosting: "cloud",
        },
      },
      request: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`)
        return ok({})
      },
    })

    await client.sendMessage({
      mode: "async",
      directory: "/repo/not-a-workspace-ref",
      sessionID: "runtime-session-1",
      agent: "build",
      model: { providerID: "claude-acp", modelID: "default" },
      messageID: "message-1",
      parts: [],
    })

    expect(calls).toEqual([
      "POST http://127.0.0.1:3001/workspaces/ws_explicit/session/runtime-session-1/prompt_async",
    ])
  })

  it("routes signed workspace-id sends through workspace-runtime", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001/",
      signedControlPlane: true,
      request: async (input, init) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
        if (String(input).includes("/api/workspace/ws_1/connection")) {
          return ok({
            access: "cloud",
            backing: "cloud-vm",
            workspaceId: "ws_1",
            relayUrl: "https://relay.example",
            runtimeAccessToken: "runtime-token",
            role: "editor",
            tokenExpiresAt: Date.now() + 120_000,
          })
        }
        return ok({})
      },
    })

    await client.sendMessage({
      mode: "async",
      directory: "ws_1",
      sessionID: "runtime-session-1",
      agent: "build",
      model: { providerID: "claude-acp", modelID: "default" },
      messageID: "message-1",
      parts: [],
    })

    expect(calls).toEqual([
      "GET http://127.0.0.1:3001/api/workspace/ws_1/connection",
      "POST https://relay.example/workspaces/ws_1/session/runtime-session-1/prompt_async Bearer runtime-token",
    ])
  })

  it("routes loopback workspace-id session lists through workspace-runtime", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001/",
      request: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`)
        return ok([{ id: "runtime-session-1" }])
      },
    })

    const result = await client.listSessions({
      directory: "workspace:ws_1",
      roots: true,
      limit: 20,
    })

    expect(result.sessions?.map((session) => session.id)).toEqual(["runtime-session-1"])
    expect(calls).toEqual([
      "GET http://127.0.0.1:3001/workspaces/ws_1/session?roots=true&limit=20",
    ])
  })

  it("routes signed legacy workspace refs through workspace-runtime", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001/",
      signedControlPlane: true,
      request: async (input, init) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
        if (String(input).includes("/api/workspace/ws_1/connection")) {
          return ok({
            access: "cloud",
            backing: "cloud-vm",
            workspaceId: "ws_1",
            relayUrl: "https://relay.example",
            runtimeAccessToken: "runtime-token",
            role: "editor",
            tokenExpiresAt: Date.now() + 120_000,
          })
        }
        return ok({})
      },
    })

    await client.sendMessage({
      mode: "async",
      directory: "workspace:ws_1",
      sessionID: "runtime-session-1",
      agent: "build",
      model: { providerID: "claude-acp", modelID: "default" },
      messageID: "message-1",
      parts: [],
    })

    expect(calls).toEqual([
      "GET http://127.0.0.1:3001/api/workspace/ws_1/connection",
      "POST https://relay.example/workspaces/ws_1/session/runtime-session-1/prompt_async Bearer runtime-token",
    ])
  })

  it("routes signed loopback workspace-id message reads through workspace-runtime", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001/",
      signedControlPlane: true,
      request: async (input, init) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
        if (String(input).includes("/api/workspace/ws_1/connection")) {
          return ok({
            access: "cloud",
            backing: "cloud-vm",
            workspaceId: "ws_1",
            relayUrl: "https://relay.example",
            runtimeAccessToken: "runtime-token",
            role: "editor",
            tokenExpiresAt: Date.now() + 120_000,
          })
        }
        return ok({ messages: [{ info: { id: "msg_1" }, parts: [] }], maxEventOrdinal: 12 })
      },
    })

    const page = await client.getMessages({
      directory: "ws_1",
      sessionID: "runtime-session-1",
      limit: 20,
      before: "cursor-1",
    })

    expect(page.data?.map((row) => row.info.id)).toEqual(["msg_1"])
    expect(page.maxEventOrdinal).toBe(12)
    expect(calls).toEqual([
      "GET http://127.0.0.1:3001/workspaces/ws_1/session/runtime-session-1/message?limit=20&before=cursor-1",
    ])
  })

  it("routes signed default-loopback workspace-id message reads through workspace-runtime", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      signedControlPlane: true,
      request: async (input, init) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
        if (String(input).includes("/api/workspace/ws_1/connection")) {
          return ok({
            access: "cloud",
            backing: "cloud-vm",
            workspaceId: "ws_1",
            relayUrl: "https://relay.example",
            runtimeAccessToken: "runtime-token",
            role: "editor",
            tokenExpiresAt: Date.now() + 120_000,
          })
        }
        return ok({ messages: [], maxEventOrdinal: 3 })
      },
    })

    const page = await client.getMessages({
      directory: "ws_1",
      sessionID: "runtime-session-1",
      limit: 20,
    })

    expect(page.maxEventOrdinal).toBe(3)
    expect(calls).toEqual([
      "GET http://127.0.0.1:3001/workspaces/ws_1/session/runtime-session-1/message?limit=20",
    ])
  })

  // Regression: a signed USER-HOSTED workspace whose `directory` is the runtime
  // filesystem path (the registration-stored remote_directory) must divert
  // session reads to the relay runtime. Before the `workspaceKind` threading,
  // this shape (workspaceId set, kind unresolved, non-ws_ directory) fell into
  // the signed-cloud contract and 404'd on `/api/control/sessions/:id/messages`.
  it("diverts signed user-hosted message reads with a filesystem directory to the relay runtime", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "https://control.example/",
      signedControlPlane: true,
      workspaceId: "ws_cleantest1",
      workspaceKind: "user-hosted",
      request: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`)
        if (String(input).includes("/api/workspace/ws_cleantest1/connection")) {
          return ok({
            access: "user-hosted",
            backing: "local-worktree",
            workspaceId: "ws_cleantest1",
            relayUrl: "https://relay.example",
            runtimeAccessToken: "runtime-token",
            role: "owner",
            tokenExpiresAt: Date.now() + 120_000,
          })
        }
        return ok({ messages: [{ info: { id: "msg_uh1" }, parts: [] }], maxEventOrdinal: 7 })
      },
    })

    const page = await client.getMessages({
      directory: "/tmp/claxedo-portability/ws_cleantest1-dir",
      sessionID: "runtime-session-1",
      limit: 80,
    })

    expect(page.data?.map((row) => row.info.id)).toEqual(["msg_uh1"])
    expect(calls.some((call) => call.includes("/api/control/sessions/"))).toBe(false)
    expect(calls.at(-1)).toContain("/workspaces/ws_cleantest1/session/runtime-session-1/message")
  })

  it("signed user-hosted getSession falls through to the relay runtime instead of the control sessions list", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "https://control.example/",
      signedControlPlane: true,
      workspaceId: "ws_cleantest1",
      workspaceKind: "user-hosted",
      request: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`)
        if (String(input).includes("/api/workspace/ws_cleantest1/connection")) {
          return ok({
            access: "user-hosted",
            backing: "local-worktree",
            workspaceId: "ws_cleantest1",
            relayUrl: "https://relay.example",
            runtimeAccessToken: "runtime-token",
            role: "owner",
            tokenExpiresAt: Date.now() + 120_000,
          })
        }
        return ok({ id: "runtime-session-1", title: "Session", directory: "/tmp/claxedo-portability/ws_cleantest1-dir" })
      },
    })

    const session = await client.getSession({
      directory: "/tmp/claxedo-portability/ws_cleantest1-dir",
      sessionID: "runtime-session-1",
    })

    expect(session.data?.id).toBe("runtime-session-1")
    expect(calls.some((call) => call.includes("/api/control/sessions"))).toBe(false)
    expect(calls.at(-1)).toContain("/workspaces/ws_cleantest1/session/runtime-session-1")
  })

  it("lets explicit signed workspace identity override local-looking refs for old user-hosted sends", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "https://control.example/",
      signedControlPlane: true,
      workspaceId: "ws_cleantest1",
      workspaceKind: "user-hosted",
      sessionRef: {
        sessionId: "runtime-session-1",
        host: "workspace",
        cwd: "/tmp/claxedo-portability/ws_cleantest1-dir",
        toolSandbox: { kind: "local", cwd: "/tmp/claxedo-portability/ws_cleantest1-dir" },
      },
      request: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`)
        if (String(input).includes("/api/workspace/ws_cleantest1/connection")) {
          return ok({
            access: "user-hosted",
            backing: "local-worktree",
            workspaceId: "ws_cleantest1",
            relayUrl: "https://relay.example",
            runtimeAccessToken: "runtime-token",
            role: "owner",
            tokenExpiresAt: Date.now() + 120_000,
          })
        }
        return ok({})
      },
    })

    await client.sendMessage({
      mode: "async",
      directory: "/tmp/claxedo-portability/ws_cleantest1-dir",
      sessionID: "runtime-session-1",
      agent: "build",
      model: { providerID: "opencode", modelID: "big-pickle" },
      messageID: "message-1",
      parts: [],
    })

    expect(calls).toEqual([
      "GET https://control.example/api/workspace/ws_cleantest1/connection",
      "POST https://relay.example/workspaces/ws_cleantest1/session/runtime-session-1/prompt_async",
    ])
  })

  it("signed user-hosted session lists come from the relay runtime instead of empty control inventory", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "https://control.example/",
      signedControlPlane: true,
      workspaceId: "ws_cleantest1",
      workspaceKind: "user-hosted",
      request: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`)
        if (String(input).includes("/api/workspace/ws_cleantest1/connection")) {
          return ok({
            access: "user-hosted",
            backing: "local-worktree",
            workspaceId: "ws_cleantest1",
            relayUrl: "https://relay.example",
            runtimeAccessToken: "runtime-token",
            role: "owner",
            tokenExpiresAt: Date.now() + 120_000,
          })
        }
        return ok([{ id: "runtime-session-1", title: "Existing session" }])
      },
    })

    const result = await client.listSessions({
      directory: "/tmp/claxedo-portability/ws_cleantest1-dir",
      roots: true,
      limit: 20,
    })

    expect(result.sessions?.map((session) => session.id)).toEqual(["runtime-session-1"])
    expect(calls.some((call) => call.includes("/api/control/sessions"))).toBe(false)
    expect(calls.at(-1)).toContain("/workspaces/ws_cleantest1/session?roots=true&limit=20")
  })

  it("routes signed real-directory sends through the resolved workspace runtime", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "https://control.example/",
      signedControlPlane: true,
      request: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`)
        if (String(input).includes("/api/workspace/resolve")) return ok({ workspaceId: "ws_real", kind: "cloud" })
        if (String(input).includes("/api/workspace/ws_real/connection")) {
          return ok({
            access: "cloud",
            backing: "cloud-vm",
            workspaceId: "ws_real",
            relayUrl: "https://control.example",
            runtimeAccessToken: "runtime-token",
            role: "editor",
            tokenExpiresAt: Date.now() + 120_000,
          })
        }
        return ok({})
      },
    })

    await client.sendMessage({
      mode: "async",
      directory: "/repo/real",
      sessionID: "runtime-session-1",
      agent: "build",
      model: { providerID: "claude-acp", modelID: "default" },
      messageID: "message-1",
      parts: [],
    })
    await client.sendMessage({
      mode: "async",
      directory: "/repo/real",
      sessionID: "runtime-session-1",
      agent: "build",
      model: { providerID: "claude-acp", modelID: "default" },
      messageID: "message-2",
      parts: [],
    })

    expect(calls).toEqual([
      "GET https://control.example/api/workspace/resolve?directory=%2Frepo%2Freal",
      "GET https://control.example/api/workspace/ws_real/connection",
      "POST https://control.example/workspaces/ws_real/session/runtime-session-1/prompt_async",
      "POST https://control.example/workspaces/ws_real/session/runtime-session-1/prompt_async",
    ])
    expect(queryClient.getQueryData<unknown>(agentRuntimeWorkspaceTargetQueryKey({
      serverUrl: "https://control.example/",
      directory: "/repo/real",
    }))).toMatchObject({
      workspaceId: "ws_real",
      workspace: { workspaceId: "ws_real", kind: "cloud" },
    })
  })

  it("routes signed real-directory sends through workspace runtime during fast-switch quiet", async () => {
    ;(globalThis as typeof globalThis & {
      __claxedoFastSessionSwitch?: { sessionId: string; until: number; networkQuietUntil: number }
    }).__claxedoFastSessionSwitch = {
      sessionId: "runtime-session-1",
      until: Date.now() + 250,
      networkQuietUntil: Date.now() + 2_000,
    }
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "https://control.example/",
      signedControlPlane: true,
      request: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`)
        if (String(input).includes("/api/workspace/resolve")) return ok({ workspaceId: "ws_real", kind: "user-hosted" })
        if (String(input).includes("/api/workspace/ws_real/connection")) {
          return ok({
            access: "user-hosted",
            backing: "local-worktree",
            workspaceId: "ws_real",
            relayUrl: "https://relay.example",
            runtimeAccessToken: "runtime-token",
            role: "editor",
            tokenExpiresAt: Date.now() + 120_000,
          })
        }
        return ok({})
      },
    })

    await client.sendMessage({
      mode: "async",
      directory: "/repo/real",
      sessionID: "runtime-session-1",
      agent: "build",
      model: { providerID: "claude-acp", modelID: "default" },
      messageID: "message-1",
      parts: [],
    })

    expect(calls).toEqual([
      "GET https://control.example/api/workspace/resolve?directory=%2Frepo%2Freal",
      "GET https://control.example/api/workspace/ws_real/connection",
      "POST https://relay.example/workspaces/ws_real/session/runtime-session-1/prompt_async",
    ])
  })

  it("exposes workspace-scoped runtime event stream URLs", () => {
    const client = createAgentRuntimeClient({
      serverUrl: "https://control.example/",
    })

    expect(String(client.subscribeToRuntimeEvents({
      directory: "/repo/main",
    }))).toBe("https://control.example/api/wr/runtime-events?directory=%2Frepo%2Fmain")
    expect(String(client.subscribeToRuntimeEvents({
      workspaceId: "ws_1",
    }))).toBe("https://control.example/workspaces/ws_1/api/wr/runtime-events")
    expect(() => client.subscribeToRuntimeEvents()).toThrow("workspaceId or directory is required")
  })
})
