import { afterEach, describe, expect, it } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { apiBearerToken, configureApiRuntime, resetApiRuntime } from "@/platform/api/api"
import { agentRuntimeWorkspaceTargetQueryKey, createAgentRuntimeClient, DEFAULT_AGENT_RUNTIME_CAPABILITIES } from "./agent-runtime-client"

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

  it("propagates the semantic latest-turn view on initial message requests", async () => {
    const seen: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001/",
      request: async (input) => {
        seen.push(String(input))
        return ok({ messages: [], maxEventOrdinal: 4 })
      },
    })

    await client.getMessages({
      directory: "/repo/main",
      sessionID: "runtime-session-1",
      view: "latest-turn",
    })

    expect(seen).toEqual([
      "http://127.0.0.1:3001/session/runtime-session-1/message?directory=%2Frepo%2Fmain&view=latest-turn",
    ])
  })

  it("propagates the semantic latest-turn view through projected workspace reads", async () => {
    const seen: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "https://control.example/",
      workspaceId: "ws_1",
      request: async (input) => {
        seen.push(String(input))
        return ok({ messages: [{ info: { id: "msg_1" }, parts: [] }], maxEventOrdinal: 4 })
      },
    })

    await client.getMessages({
      directory: "/repo/main",
      sessionID: "runtime-session-1",
      view: "latest-turn",
    })

    expect(seen).toEqual([
      "https://control.example/api/control/sessions/runtime-session-1/messages?workspaceId=ws_1&view=latest-turn",
    ])
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

  it("routes every Goal operation through the session authority", async () => {
    const seen: Array<{ url: string; method: string; body?: string }> = []
    const goal = {
      sessionId: "runtime-session-1",
      objective: "Ship verified work",
      status: "active",
      createdAt: 1,
      updatedAt: 2,
    }
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001/",
      request: async (input, init) => {
        seen.push({
          url: String(input),
          method: init?.method ?? "GET",
          ...(typeof init?.body === "string" ? { body: init.body } : {}),
        })
        if (String(input).endsWith("/capabilities?directory=%2Frepo%2Fmain")) {
          return ok({ implemented: true, available: true, actions: ["pause", "resume", "delete"], recovery: "reconcile", optionalFields: [] })
        }
        if ((init?.method ?? "GET") === "GET") return ok(goal)
        return ok({ ok: true, goal: init?.method === "DELETE" ? null : goal })
      },
    })
    const scope = { directory: "/repo/main", sessionID: "runtime-session-1" }

    await client.getGoalCapabilities(scope)
    await client.startGoal({ ...scope, objective: goal.objective })
    await client.pauseGoal(scope)
    await client.resumeGoal(scope)
    await client.stopGoal(scope)
    await client.deleteGoal(scope)

    expect(seen).toEqual([
      { url: "http://127.0.0.1:3001/session/runtime-session-1/goal/capabilities?directory=%2Frepo%2Fmain", method: "GET" },
      { url: "http://127.0.0.1:3001/session/runtime-session-1/goal?directory=%2Frepo%2Fmain", method: "POST", body: JSON.stringify({ objective: goal.objective }) },
      { url: "http://127.0.0.1:3001/session/runtime-session-1/goal/pause?directory=%2Frepo%2Fmain", method: "POST", body: "{}" },
      { url: "http://127.0.0.1:3001/session/runtime-session-1/goal/resume?directory=%2Frepo%2Fmain", method: "POST", body: "{}" },
      { url: "http://127.0.0.1:3001/session/runtime-session-1/goal/stop?directory=%2Frepo%2Fmain", method: "POST", body: "{}" },
      { url: "http://127.0.0.1:3001/session/runtime-session-1/goal?directory=%2Frepo%2Fmain", method: "DELETE" },
    ])
  })

  it("resolves draft capabilities for the selected harness", async () => {
    const seen: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001/",
      request: async (input) => {
        seen.push(String(input))
        return ok({ ...DEFAULT_AGENT_RUNTIME_CAPABILITIES, transport: "codex", goals: true })
      },
    })

    const capabilities = await client.getCapabilities({ directory: "/repo/main", harness: "codex" })

    expect(capabilities.goals).toBe(true)
    expect(seen).toEqual([
      "http://127.0.0.1:3001/session/capabilities?directory=%2Frepo%2Fmain&harness=codex",
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

  it("forwards cancellation to the injected SDK and rejects a late ignored result", async () => {
    const controller = new AbortController()
    let resolveMessages!: () => void
    let receivedSignal: AbortSignal | undefined
    const client = createAgentRuntimeClient({
      request: async () => {
        throw new Error("request should not be used")
      },
      opencodeClient: {
        session: {
          async messages(_input, options) {
            receivedSignal = options?.signal
            await new Promise<void>((resolve) => { resolveMessages = resolve })
            return { data: [], response: ok([]) }
          },
        },
      },
    })

    const read = client.getMessages({
      directory: "opencode",
      sessionID: "ses_abort",
      view: "latest-surface",
      signal: controller.signal,
    })
    await Promise.resolve()
    expect(receivedSignal).toBe(controller.signal)

    controller.abort()
    resolveMessages()
    await expect(read).rejects.toMatchObject({ name: "AbortError" })
  })

  it("does not parse a runtime response after its read epoch is aborted", async () => {
    const controller = new AbortController()
    let resolveRequest!: (response: Response) => void
    let parses = 0
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001/",
      request: async () => await new Promise<Response>((resolve) => { resolveRequest = resolve }),
    })
    const response = new Response("[]")
    Object.defineProperty(response, "json", {
      value: async () => {
        parses++
        return []
      },
    })

    const read = client.getMessages({
      directory: "/repo/main",
      sessionID: "ses_abort",
      view: "latest-surface",
      signal: controller.signal,
    })
    await Promise.resolve()
    controller.abort()
    resolveRequest(response)

    await expect(read).rejects.toMatchObject({ name: "AbortError" })
    expect(parses).toBe(0)
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
        harness: { id: "pi" },
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
      "POST http://127.0.0.1:3001/api/control/session/ses_central/prompt_async?directory=",
      "GET http://127.0.0.1:3001/api/control/session/ses_central/message?directory=&limit=20",
    ])
    expect(bodies).toEqual([expect.objectContaining({
      directory: "",
      sessionID: "ses_central",
    })])
    expect(page.maxEventOrdinal).toBe(5)
  })

  it("rejects directory-less central sessions on non-Pi harnesses", async () => {
    const client = createAgentRuntimeClient({
      sessionRef: {
        sessionId: "ses_opencode",
        host: "central",
        harness: { id: "opencode" },
        toolSandbox: { kind: "virtual" },
      },
    })

    await expect(client.getMessages({
      directory: "",
      sessionID: "ses_opencode",
      limit: 20,
    })).rejects.toThrow("Directory-less central sessions require the Pi harness")
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

  /**
   * Where the signed control plane's bearer comes from.
   *
   * This client used to import `getAuthToken` from `@/platform/auth/auth-client`
   * for this one header, which put Clerk in the local product's bundle for a
   * code path a local build never reaches. It now reads whatever the build
   * bound through `configureApiRuntime({ bearerToken })` — the same source
   * `authFetch` uses — so the two cases below are "hosted" and "local", not
   * "works" and "broken".
   *
   * `/repo/bearer-*` directories are distinct per test because `workspaceTarget`
   * caches its resolve in `queryClient` by (serverUrl, directory).
   */
  async function signedResolveAuthorization(directory: string) {
    const seen: Array<string | null> = []
    const client = createAgentRuntimeClient({
      serverUrl: "https://control.example/",
      signedControlPlane: true,
      request: async (input, init) => {
        if (String(input).includes("/api/workspace/resolve")) {
          seen.push(new Headers(init?.headers).get("Authorization"))
          return ok({ workspaceId: "ws_bearer", kind: "cloud" })
        }
        if (String(input).includes("/api/workspace/ws_bearer/connection")) {
          return ok({
            access: "cloud",
            backing: "cloud-vm",
            workspaceId: "ws_bearer",
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
      directory,
      sessionID: "runtime-session-1",
      agent: "build",
      model: { providerID: "claude-acp", modelID: "default" },
      messageID: "message-1",
      parts: [],
    })
    return seen
  }

  it("sends the bearer the build bound through configureApiRuntime", async () => {
    configureApiRuntime({ bearerToken: async () => "tok_bound" })
    try {
      // Bisects the win32-CI failure mode (runs 382/383: header observed null):
      // a failure here means the runtime cfg did not hold the binding at all; a
      // failure only below means the client's header-attach path dropped it.
      expect(await apiBearerToken()).toBe("tok_bound")
      expect(await signedResolveAuthorization("/repo/bearer-bound")).toEqual(["Bearer tok_bound"])
    } finally {
      resetApiRuntime()
    }
  })

  it("sends no authorization when the build bound no bearer source", async () => {
    // The local product: `app/entry/local.tsx` binds nothing, which is the whole
    // reason it can ship without an identity provider. An absent bearer is a
    // state this path already handled — the header is simply omitted.
    resetApiRuntime()

    expect(await signedResolveAuthorization("/repo/bearer-unbound")).toEqual([null])
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
