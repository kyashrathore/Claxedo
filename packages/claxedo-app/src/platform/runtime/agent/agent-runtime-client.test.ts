import { afterEach, describe, expect, it } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { apiBearerToken, configureApiRuntime, resetApiRuntime } from "@/platform/api/api"
import { agentRuntimeWorkspaceTargetQueryKey, createAgentRuntimeClient } from "./agent-runtime-client"
import { AgentRuntimeRequestError } from "./agent-runtime-request-error"
import { requestUrl } from "@/lib/url"

// `...init` must come before `headers`: spreading it last would drop the merged
// headers entirely (the old shape spread `init.headers` into an object literal
// and then let `...init` overwrite the result, silently losing Content-Type).
// `new Headers()` also accepts every `HeadersInit` arm, which an object spread
// does not — spreading a `Headers` instance yields nothing at all.
function ok(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers)
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json")
  return new Response(JSON.stringify(body), { status: 200, ...init, headers })
}

describe("AgentRuntimeClient", () => {
  it("omits an agent-managed model from actual create and prompt wire bodies", async () => {
    const bodies: Record<string, unknown>[] = []
    const client = createAgentRuntimeClient({ serverUrl: "http://127.0.0.1:3001", request: async (_request, init) => {
      // A `BodyInit` that is not already serialized would stringify to
      // "[object Object]" and the wire assertion below would read an empty body.
      if (typeof init?.body !== "string") throw new Error("the client must send a serialized JSON body")
      bodies.push(JSON.parse(init.body) as Record<string, unknown>)
      return ok({ id: "session-1" })
    } })
    await client.createSession({ directory: "/repo", harness: { kind: "connection", connectionId: "agent" }, agent: "build" })
    await client.sendMessage({ directory: "/repo", sessionID: "session-1", agent: "build", messageID: "message-1", parts: [{ type: "text", text: "hello" }] })
    expect(bodies).toHaveLength(2)
    expect(bodies.every((body) => !Object.hasOwn(body, "model"))).toBe(true)
  })
  it("retains a 202 steering operation as pending rather than treating HTTP success as acceptance", async () => {
    const outcome = { ok: false, status: "pending", operationId: "attempt-1", message: "Awaiting provider acknowledgement" }
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001",
      request: async () => ok(outcome, { status: 202 }),
    })
    expect(await client.controlQueuedMessage({ directory: "/repo", sessionID: "session-1", seq: 1, action: "steer" })).toEqual(outcome)
  })
  it("uses the session's permission owner and disambiguates native versus connection drafts", async () => {
    const calls: URL[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001",
      request: async (input) => {
        calls.push(new URL(requestUrl(input)))
        return ok({ modes: [], appliesFrom: "next-turn" })
      },
    })
    await client.getPermissionModes({ directory: "/repo", sessionID: "session-1", harness: { kind: "native", harnessId: "pi" } })
    await client.getPermissionModes({ directory: "/repo", sessionID: "", harness: { kind: "native", harnessId: "pi" } })
    await client.getPermissionModes({ directory: "/repo", sessionID: "", harness: { kind: "connection", connectionId: "pi" } })
    expect(calls[0]?.pathname).toBe("/session/session-1/permission-mode")
    expect([...calls[0].searchParams]).toEqual([["directory", "/repo"]])
    expect(calls[1]?.searchParams.get("nativeHarness")).toBe("pi")
    expect(calls[1]?.searchParams.has("connectionId")).toBe(false)
    expect(calls[2]?.searchParams.get("connectionId")).toBe("pi")
    expect(calls[2]?.searchParams.has("nativeHarness")).toBe(false)
    expect(calls.every((url) => !url.searchParams.has("harness"))).toBe(true)
    await expect(client.getPermissionModes({ directory: "/repo", sessionID: "" })).rejects.toThrow("require a harness selection")
    expect(calls).toHaveLength(3)
  })

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
        seen.push(requestUrl(input))
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
        seen.push(requestUrl(input))
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

  it("propagates the semantic latest-turn view through workspace-runtime reads", async () => {
    const seen: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001/",
      workspaceId: "ws_1",
      request: async (input) => {
        seen.push(requestUrl(input))
        return ok({ messages: [{ info: { id: "msg_1" }, parts: [] }], maxEventOrdinal: 4 })
      },
    })

    await client.getMessages({
      directory: "/repo/main",
      sessionID: "runtime-session-1",
      view: "latest-turn",
    })

    expect(seen).toEqual([
      "http://127.0.0.1:3001/workspaces/ws_1/session/runtime-session-1/message?view=latest-turn",
    ])
  })

  it("rejects malformed history instead of synthesizing an empty transcript", async () => {
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001/",
      request: async () => ok({ maxEventOrdinal: 0 }),
    })

    await expect(client.getMessages({
      directory: "/repo/main",
      sessionID: "runtime-session-1",
      limit: 20,
    })).rejects.toMatchObject({ status: 502, code: "invalid_response" })
  })

  it("parses prompt admission conflicts into a structured request error", async () => {
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001/",
      request: async () => new Response(JSON.stringify({
        error: { code: "session_turn_in_progress", message: "Session is already processing a turn" },
      }), { status: 409, headers: { "Content-Type": "application/json" } }),
    })

    const error = await client.sendMessage({
      mode: "async",
      directory: "/repo/main",
      sessionID: "runtime-session-1",
      agent: "build",
      model: { providerID: "test", modelID: "fixture" },
      messageID: "loser",
      parts: [],
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(AgentRuntimeRequestError)
    expect(error).toMatchObject({ status: 409, code: "session_turn_in_progress" })
  })

  it("routes signed capability requests through workspace-runtime", async () => {
    const seen: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "https://control.example/",
      signedControlPlane: true,
      request: async (input) => {
        seen.push(requestUrl(input))
        if (requestUrl(input).includes("/api/workspace/ws_1/connection")) {
          return ok({
            backing: "cloud-vm",
            sessionAuthority: "managed-private",
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
          url: requestUrl(input),
          method: init?.method ?? "GET",
          ...(typeof init?.body === "string" ? { body: init.body } : {}),
        })
        if (requestUrl(input).endsWith("/capabilities?directory=%2Frepo%2Fmain")) {
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
        seen.push(requestUrl(input))
        return ok({ transport: "codex", goals: true })
      },
    })

    const capabilities = await client.getCapabilities({ directory: "/repo/main", harness: { kind: "native", harnessId: "codex" } })

    expect(capabilities.goals).toBe(true)
    expect(seen).toEqual([
      "http://127.0.0.1:3001/session/capabilities?directory=%2Frepo%2Fmain&nativeHarness=codex",
    ])
  })

  it("keeps same-named native and connection draft capability requests distinct", async () => {
    const seen: URL[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001/",
      request: async (input) => {
        seen.push(new URL(requestUrl(input)))
        return ok({ goals: seen.at(-1)?.searchParams.has("nativeHarness") })
      },
    })
    expect((await client.getCapabilities({ directory: "/repo", harness: { kind: "native", harnessId: "pi" } })).goals).toBe(true)
    expect((await client.getCapabilities({ directory: "/repo", harness: { kind: "connection", connectionId: "pi" } })).goals).toBe(false)
    expect(seen.map((url) => Object.fromEntries(url.searchParams))).toEqual([
      { directory: "/repo", nativeHarness: "pi" },
      { directory: "/repo", connectionId: "pi" },
    ])
  })

  it("keeps non-workspace legacy OpenCode sessions on the injected SDK client", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001/",
      request: async (input) => {
        calls.push(requestUrl(input))
        return ok({ messages: [], maxEventOrdinal: 7 })
      },
    })

    const page = await client.getMessages({
      directory: "opencode",
      sessionID: "ses_1",
      limit: 10,
    })

    expect(calls).toEqual([
      "http://127.0.0.1:3001/session/ses_1/message?directory=opencode&limit=10",
    ])
    expect(page.maxEventOrdinal).toBe(7)
  })

  it("forwards cancellation to the canonical runtime request", async () => {
    const controller = new AbortController()
    let resolveRequest!: (response: Response) => void
    let receivedSignal: AbortSignal | undefined
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001/",
      request: async (_input, init) => {
        receivedSignal = init?.signal ?? undefined
        return await new Promise<Response>((resolve) => { resolveRequest = resolve })
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
    resolveRequest(ok({ messages: [], maxEventOrdinal: 0 }))
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

  it("routes filesystem sessions through runtime transport for durable workspace state", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001/",
      request: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${requestUrl(input)}`)
        return ok([{ info: { id: "msg_1" }, parts: [] }], { headers: { "x-max-event-ordinal": "8" } })
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

  it("routes scoped sends through runtime session routes", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001/",
      request: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${requestUrl(input)}`)
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
        const url = new URL(requestUrl(input))
        if (url.pathname.startsWith("/workspaces/") || url.pathname.startsWith("/api/workspace")) {
          throw new Error(`local cwd session should stay on local session routes: ${url.pathname}`)
        }
        calls.push(`${init?.method ?? "GET"} ${requestUrl(input)}`)
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


  it("rejects directoryless session prompts", async () => {
    const client = createAgentRuntimeClient({
      sessionRef: {
        sessionId: "ses_opencode",
        host: "workspace",
        harness: { id: "opencode" },
        toolSandbox: { kind: "local", cwd: "/repo" },
      },
    })

    await expect(client.getMessages({
      directory: "",
      sessionID: "ses_opencode",
      limit: 20,
    })).rejects.toThrow("A machine workspace directory is required")
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
          hosting: "provisioner",
        },
      },
      request: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${requestUrl(input)}`)
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
        const req = input instanceof Request ? input : new Request(requestUrl(input), init)
        calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
        if (requestUrl(input).includes("/api/workspace/ws_1/connection")) {
          return ok({
            backing: "cloud-vm",
            sessionAuthority: "managed-private",
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
      "POST http://127.0.0.1:3001/api/workspace/ws_1/connection",
      "POST https://relay.example/workspaces/ws_1/session/runtime-session-1/prompt_async Bearer runtime-token",
    ])
  })

  it("routes loopback workspace-id session lists through workspace-runtime", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001/",
      request: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${requestUrl(input)}`)
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
        const req = input instanceof Request ? input : new Request(requestUrl(input), init)
        calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
        if (requestUrl(input).includes("/api/workspace/ws_1/connection")) {
          return ok({
            backing: "cloud-vm",
            sessionAuthority: "managed-private",
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
      "POST http://127.0.0.1:3001/api/workspace/ws_1/connection",
      "POST https://relay.example/workspaces/ws_1/session/runtime-session-1/prompt_async Bearer runtime-token",
    ])
  })

  it("routes signed loopback workspace-id message reads through workspace-runtime", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "http://127.0.0.1:3001/",
      signedControlPlane: true,
      request: async (input, init) => {
        const req = input instanceof Request ? input : new Request(requestUrl(input), init)
        calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
        if (requestUrl(input).includes("/api/workspace/ws_1/connection")) {
          return ok({
            backing: "cloud-vm",
            sessionAuthority: "managed-private",
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
        const req = input instanceof Request ? input : new Request(requestUrl(input), init)
        calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
        if (requestUrl(input).includes("/api/workspace/ws_1/connection")) {
          return ok({
            backing: "cloud-vm",
            sessionAuthority: "managed-private",
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

  // A signed USER-HOSTED workspace whose `directory` is the runtime filesystem
  // path (the registration-stored remote_directory) must divert session reads
  // to the relay runtime: this shape (workspaceId set, kind unresolved, non-ws_
  // directory) is exactly the case `hostKind` threading exists to steer
  // away from the signed-cloud contract, which 404s on
  // `/api/control/sessions/:id/messages` for it.
  it("diverts signed machine-placed message reads with a filesystem directory to the relay runtime", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "https://control.example/",
      signedControlPlane: true,
      workspaceId: "ws_cleantest1",
      hostKind: "machine",
      request: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${requestUrl(input)}`)
        if (requestUrl(input).includes("/api/workspace/ws_cleantest1/connection")) {
          return ok({
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

  it("surfaces offline machine-placed history as an error instead of an empty transcript", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "https://control.example/",
      signedControlPlane: true,
      workspaceId: "ws_cleantest1",
      hostKind: "machine",
      request: async (input) => {
        calls.push(requestUrl(input))
        if (requestUrl(input).includes("/api/workspace/ws_cleantest1/connection")) {
          return ok({
            backing: "local-worktree",
            workspaceId: "ws_cleantest1",
            relayUrl: "https://relay.example",
            runtimeAccessToken: "runtime-token",
            role: "owner",
            tokenExpiresAt: Date.now() + 120_000,
          })
        }
        return new Response(JSON.stringify({
          error: { code: "workspace_offline", message: "Workspace runtime is offline" },
        }), { status: 503, headers: { "Content-Type": "application/json" } })
      },
    })

    await expect(client.getMessages({
      directory: "/tmp/claxedo-portability/ws_cleantest1-dir",
      sessionID: "runtime-session-1",
      limit: 80,
    })).rejects.toMatchObject({ status: 503, code: "workspace_offline" })
    expect(calls.some((call) => call.includes("/api/control/sessions/"))).toBe(false)
  })

  it("signed machine-placed getSession falls through to the relay runtime instead of the control sessions list", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "https://control.example/",
      signedControlPlane: true,
      workspaceId: "ws_cleantest1",
      hostKind: "machine",
      request: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${requestUrl(input)}`)
        if (requestUrl(input).includes("/api/workspace/ws_cleantest1/connection")) {
          return ok({
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

  it("lets explicit signed workspace identity override local-looking refs for machine-placed sends", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "https://control.example/",
      signedControlPlane: true,
      workspaceId: "ws_cleantest1",
      hostKind: "machine",
      sessionRef: {
        sessionId: "runtime-session-1",
        host: "workspace",
        cwd: "/tmp/claxedo-portability/ws_cleantest1-dir",
        toolSandbox: { kind: "local", cwd: "/tmp/claxedo-portability/ws_cleantest1-dir" },
      },
      request: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${requestUrl(input)}`)
        if (requestUrl(input).includes("/api/workspace/ws_cleantest1/connection")) {
          return ok({
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
      "POST https://control.example/api/workspace/ws_cleantest1/connection",
      "POST https://relay.example/workspaces/ws_cleantest1/session/runtime-session-1/prompt_async",
    ])
  })

  it("signed machine-placed session lists come from the relay runtime instead of empty control inventory", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "https://control.example/",
      signedControlPlane: true,
      workspaceId: "ws_cleantest1",
      hostKind: "machine",
      request: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${requestUrl(input)}`)
        if (requestUrl(input).includes("/api/workspace/ws_cleantest1/connection")) {
          return ok({
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

  // When the client is not told the workspace id up front, `listSessions`
  // resolves it live via `/api/workspace/resolve` — but that read confirms only a
  // `workspaceId` for a machine-placed workspace addressed by its filesystem-path
  // directory, never a `kind` (the control plane does not track the kind of a
  // directory it does not own). The caller-confirmed `hostKind` (threaded down
  // from the signed inventory) must still steer `listSessions` to the relay
  // runtime instead of the central sessions list, which holds nothing for a
  // machine's workspaces.
  it("signed machine-placed session lists use the caller-confirmed host kind when the live resolve confirms only an id", async () => {
    const calls: string[] = []
    const client = createAgentRuntimeClient({
      serverUrl: "https://control.example/",
      signedControlPlane: true,
      hostKind: "machine",
      request: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${requestUrl(input)}`)
        if (requestUrl(input).includes("/api/workspace/resolve")) {
          return ok({ workspaceId: "ws_cleantest1" })
        }
        if (requestUrl(input).includes("/api/workspace/ws_cleantest1/connection")) {
          return ok({
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
        calls.push(`${init?.method ?? "GET"} ${requestUrl(input)}`)
        if (requestUrl(input).includes("/api/workspace/resolve")) return ok({ workspaceId: "ws_real", kind: "cloud" })
        if (requestUrl(input).includes("/api/workspace/ws_real/connection")) {
          return ok({
            backing: "cloud-vm",
            sessionAuthority: "managed-private",
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
      "POST https://control.example/api/workspace/ws_real/connection",
      "POST https://control.example/workspaces/ws_real/session/runtime-session-1/prompt_async",
      "POST https://control.example/workspaces/ws_real/session/runtime-session-1/prompt_async",
    ])
    expect(queryClient.getQueryData<unknown>(agentRuntimeWorkspaceTargetQueryKey({
      serverUrl: "https://control.example/",
      directory: "/repo/real",
    }))).toMatchObject({
      workspaceId: "ws_real",
      workspace: { workspaceId: "ws_real", kind: "provisioner" },
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
        calls.push(`${init?.method ?? "GET"} ${requestUrl(input)}`)
        if (requestUrl(input).includes("/api/workspace/resolve")) return ok({ workspaceId: "ws_real", kind: "user-hosted" })
        if (requestUrl(input).includes("/api/workspace/ws_real/connection")) {
          return ok({
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
      "POST https://control.example/api/workspace/ws_real/connection",
      "POST https://relay.example/workspaces/ws_real/session/runtime-session-1/prompt_async",
    ])
  })

  /**
   * Where the signed control plane's bearer comes from.
   *
   * Reads whatever the build bound through `configureApiRuntime({ bearerToken })`
   * — the same source `authFetch` uses — so the two cases below are "hosted"
   * and "local", not "works" and "broken": the local build simply never binds
   * one.
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
        if (requestUrl(input).includes("/api/workspace/resolve")) {
          seen.push(new Headers(init?.headers).get("Authorization"))
          return ok({ workspaceId: "ws_bearer", kind: "provisioner" })
        }
        if (requestUrl(input).includes("/api/workspace/ws_bearer/connection")) {
          return ok({
            backing: "cloud-vm",
            sessionAuthority: "managed-private",
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
      // A failure here means the runtime cfg did not hold the binding at all; a
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

})
