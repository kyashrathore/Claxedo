import { afterEach, describe, expect, test } from "bun:test"
import { NO_HARNESS_EFFORT, type AgentWorkspaceExecutionBinding, type PromptInput } from "@claxedo/agent-runtime-contract"
import { createConnectionProviderRegistry, type HarnessConnectionDescriptor } from "@claxedo/agent-sdk-runtime"
import { createOpenCodeServerConnectionProvider, OPENCODE_SERVER_CONNECTION_PROVIDER_KEY } from "./index"
import type { OpenCodeServerConnectionConfig } from "./config"

const SOURCE = "/local/repo"
const TARGET = "/remote/repo"
const servers: Bun.Server<unknown>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
})

function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: handler })
  servers.push(server)
  return `http://127.0.0.1:${server.port}`
}

function descriptor(baseUrl: string, overrides: Partial<OpenCodeServerConnectionConfig> = {}): HarnessConnectionDescriptor<OpenCodeServerConnectionConfig> {
  const provider = createOpenCodeServerConnectionProvider()
  return {
    connectionId: "external-opencode",
    providerKey: OPENCODE_SERVER_CONNECTION_PROVIDER_KEY,
    configRevision: 1,
    enabled: true,
    config: provider.validateConfig({
      label: "Team OpenCode",
      baseUrl,
      workspacePaths: [{ sourceDirectory: SOURCE, targetDirectory: TARGET }],
      ...overrides,
    }),
  }
}

async function connect(input: {
  descriptor: HarnessConnectionDescriptor<OpenCodeServerConnectionConfig>
  secrets?: Readonly<Record<string, string>>
  provider?: ReturnType<typeof createOpenCodeServerConnectionProvider>
}) {
  const provider = input.provider ?? createOpenCodeServerConnectionProvider()
  const resolved = await provider.resolve({ descriptor: input.descriptor, directory: SOURCE, secrets: input.secrets ?? {} })
  return provider.createAdapter({ descriptor: input.descriptor, resolved, context: {} as never })
}

function binding(overrides: Partial<AgentWorkspaceExecutionBinding> = {}): AgentWorkspaceExecutionBinding {
  return {
    workspaceId: "ws_1",
    directory: SOURCE,
    sessionId: "claxedo_ses_1",
    connectionId: "connection:external-opencode",
    upstreamSessionId: "ses_upstream",
    ...overrides,
  }
}

function prompt(): PromptInput {
  return {
    assistantMessageId: "msg_assistant",
    userMessageId: "msg_user",
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-5" },
    parts: [{ type: "text", text: "hello" }],
  }
}

async function collect<T>(stream: AsyncIterable<T>) {
  const values: T[] = []
  for await (const value of stream) values.push(value)
  return values
}

function envelope(directory: string, payload: Record<string, unknown>) {
  return `data: ${JSON.stringify({ directory, payload: { id: crypto.randomUUID(), ...payload } })}\n\n`
}

describe("OpenCode server provider trust boundary", () => {
  test.each([301, 302, 303, 307, 308])("rejects HTTP %s redirects before forwarding connection secrets", async (status) => {
    let foreignRequests = 0
    const foreign = serve(() => {
      foreignRequests += 1
      return Response.json({ id: "ses_upstream", directory: TARGET })
    })
    const received: Array<[string | null, string | null]> = []
    const origin = serve((request) => {
      received.push([request.headers.get("x-api-key"), request.headers.get("x-trusted")])
      return new Response(null, { status, headers: { Location: `${foreign}/session/ses_upstream` } })
    })
    const item = descriptor(origin, {
      auth: { type: "header", name: "X-API-Key", valueSecret: "apiKey" },
      trustedHeaders: { "X-Trusted": "trusted" },
    })
    item.secretRefs = { apiKey: "credential-api", trusted: "credential-trusted" }
    const adapter = await connect({
      descriptor: item,
      secrets: { apiKey: "test-api-secret", trusted: "test-trusted-secret" },
    })
    try {
      await expect(adapter.getSession(binding())).rejects.toMatchObject({ code: "transport_error" })
      expect(received).toEqual([["test-api-secret", "test-trusted-secret"]])
      expect(foreignRequests).toBe(0)
    } finally {
      await adapter.dispose()
    }
  })

  test("projects the Claxedo workspace identity without trusting the upstream project ID", async () => {
    const baseUrl = serve(() => Response.json({
      id: "ses_upstream",
      directory: TARGET,
      projectID: "opaque-opencode-project",
    }))
    const session = await (await connect({ descriptor: descriptor(baseUrl) })).getSession(binding())

    expect(session).toMatchObject({
      id: "claxedo_ses_1",
      workspaceId: "ws_1",
      directory: SOURCE,
      projectID: "opaque-opencode-project",
    })
  })

  test("resolves secret references without placing values or lease generations in descriptor config", async () => {
    const seen: Array<string | null> = []
    const baseUrl = serve((request) => {
      seen.push(request.headers.get("x-api-key"))
      return Response.json({ id: "ses_upstream", directory: TARGET })
    })
    const provider = createOpenCodeServerConnectionProvider()
    const item = descriptor(baseUrl, { auth: { type: "header", name: "X-API-Key", valueSecret: "apiKey" } })
    item.secretRefs = { apiKey: "vault://opencode/api-key" }

    const first = await provider.resolve({ descriptor: item, directory: SOURCE, secrets: { apiKey: "first-secret" } })
    const second = await provider.resolve({ descriptor: item, directory: SOURCE, secrets: { apiKey: "rotated-secret" } })
    expect(first).not.toHaveProperty("secretLeaseGeneration")
    expect(JSON.stringify(item)).not.toContain("first-secret")
    expect(JSON.stringify(provider.project(item.config))).not.toContain("vault://")

    const firstAdapter = provider.createAdapter({ descriptor: item, resolved: first, context: {} as never })
    const secondAdapter = provider.createAdapter({ descriptor: item, resolved: second, context: {} as never })
    await firstAdapter.getSession(binding())
    await secondAdapter.getSession(binding())
    expect(seen).toEqual(["first-secret", "rotated-secret"])
  })

  test("leaves secret lease generation ownership with the host registry", async () => {
    const provider = createOpenCodeServerConnectionProvider()
    const item = descriptor("https://opencode.example.test", {
      auth: { type: "header", name: "X-API-Key", valueSecret: "apiKey" },
    })
    item.secretRefs = { apiKey: "vault://opencode/api-key" }
    const registry = createConnectionProviderRegistry([provider])

    const result = await registry.resolve({
      descriptor: item,
      directory: SOURCE,
      context: {} as never,
      secretLease: { secrets: { apiKey: "resolved-only-at-host" }, secretLeaseGeneration: "lease-7" },
    })
    expect(result.connectionGeneration).toEqual({ configRevision: 1, secretLeaseGeneration: "lease-7" })
  })

  test("rejects workspace retargeting under the same connection identity", async () => {
    const provider = createOpenCodeServerConnectionProvider()
    const first = descriptor("https://one.example.test", { tenant: { header: "X-Tenant", value: "team-1" } })
    const registry = createConnectionProviderRegistry([provider])

    const retargeted = descriptor("https://two.example.test", {
      tenant: { header: "X-Tenant", value: "team-2" },
      workspacePaths: [{ sourceDirectory: SOURCE, targetDirectory: "/other/repo" }],
    })
    retargeted.configRevision = 2
    expect(() => registry.assertRevision(retargeted, first)).toThrow(
      expect.objectContaining({ code: "immutable_connection_identity" }),
    )
  })

  test("requires an exact validated source-to-target workspace mapping", async () => {
    const provider = createOpenCodeServerConnectionProvider()
    expect(() => descriptor("https://opencode.example.test", {
      workspacePaths: [{ sourceDirectory: "relative", targetDirectory: TARGET }],
    })).toThrow("absolute")
    expect(() => provider.resolve({
      descriptor: descriptor("https://opencode.example.test"),
      directory: "/local/other",
      secrets: {},
    })).toThrow(expect.objectContaining({ code: "invalid_directory" }))
  })
})

describe("OpenCodeServerAdapter real HTTP/SSE protocol", () => {
  test("probes compatibility before mutation and maps Basic plus trusted headers to the target workspace", async () => {
    const calls: Request[] = []
    const baseUrl = serve(async (request) => {
      calls.push(request.clone())
      const url = new URL(request.url)
      if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.2.3" })
      if (url.pathname === "/session" && request.method === "POST") {
        expect(await request.json()).toEqual({ title: "Review" })
        return Response.json({ id: "ses_upstream", directory: TARGET })
      }
      return new Response("missing", { status: 404 })
    })
    const item = descriptor(baseUrl, {
      auth: { type: "basic", username: "alice", passwordSecret: "password" },
      trustedHeaders: { "X-API-Key": "apiKey" },
      tenant: { header: "X-Tenant", value: "team-1" },
    })
    item.secretRefs = { password: "vault://password", apiKey: "vault://api-key" }
    const adapter = await connect({ descriptor: item, secrets: { password: "secret", apiKey: "key-1" } })

    await expect(adapter.createSession(SOURCE, "Review", "claxedo_ses_1")).resolves.toEqual({
      id: "claxedo_ses_1",
      agentSessionId: "ses_upstream",
    })
    expect(calls.map((request) => new URL(request.url).pathname)).toEqual(["/global/health", "/session"])
    for (const request of calls) {
      expect(request.headers.get("authorization")).toBe(`Basic ${Buffer.from("alice:secret").toString("base64")}`)
      expect(request.headers.get("x-api-key")).toBe("key-1")
      expect(request.headers.get("x-tenant")).toBe("team-1")
      expect(request.headers.get("x-opencode-directory")).toBe(TARGET)
    }
  })

  test("never mutates an incompatible server and bounds and redacts its error", async () => {
    let mutations = 0
    const leaked = "do-not-leak"
    const encoded = Buffer.from(`alice:${leaked}`).toString("base64")
    const baseUrl = serve((request) => {
      if (new URL(request.url).pathname === "/global/health") {
        return new Response(`Basic ${encoded}:${leaked}:${"x".repeat(20_000)}`, { status: 502 })
      }
      mutations += 1
      return Response.json({ id: "unexpected" })
    })
    const item = descriptor(baseUrl, { auth: { type: "basic", username: "alice", passwordSecret: "password" } })
    item.secretRefs = { password: "vault://password" }
    const adapter = await connect({ descriptor: item, secrets: { password: leaked } })

    let error: unknown
    try { await adapter.createSession(SOURCE) } catch (value) { error = value }
    expect(error).toMatchObject({ code: "compatibility_probe_failed" })
    expect(JSON.stringify(error)).not.toContain(leaked)
    expect(JSON.stringify(error)).not.toContain(encoded)
    expect(JSON.stringify(error).length).toBeLessThan(6_000)
    expect(mutations).toBe(0)
  })

  test("applies a bounded compatibility request deadline", async () => {
    const baseUrl = serve(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return Response.json({ healthy: true, version: "late" })
    })
    const adapter = await connect({
      descriptor: descriptor(baseUrl, { deadlines: { requestMs: 5, streamIdleMs: 50 } }),
    })
    await expect(adapter.createSession(SOURCE)).rejects.toMatchObject({ code: "deadline_exceeded" })
  })

  test("enforces the mapped directory and upstream session and reconciles a no-ID disconnect from snapshots", async () => {
    let streams = 0
    let userMessageId = ""
    const lastEventIds: Array<string | null> = []
    const baseUrl = serve(async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.2.3" })
      if (url.pathname === "/global/event") {
        streams += 1
        lastEventIds.push(request.headers.get("last-event-id"))
        if (streams === 1) {
          return new Response([
            `data: ${JSON.stringify({ payload: { id: crypto.randomUUID(), type: "server.connected", properties: {} } })}\n\n`,
            envelope(TARGET, { type: "sync", syncEvent: { id: crypto.randomUUID() } }),
            envelope("/foreign/repo", { type: "session.idle", properties: { sessionID: "ses_upstream" } }),
            envelope(TARGET, { type: "session.idle", properties: { sessionID: "foreign_session" } }),
            envelope(TARGET, { type: "session.idle", properties: {} }),
            envelope(TARGET, {
              type: "message.part.updated",
              properties: { part: { id: "part_1", messageID: "msg_assistant", sessionID: "ses_upstream", type: "text", text: "hello" } },
            }),
          ].join(""), { headers: { "Content-Type": "text/event-stream" } })
        }
        return new Response([
          envelope(TARGET, {
            type: "message.part.updated",
            properties: { part: { id: "part_1", messageID: "msg_assistant", sessionID: "ses_upstream", type: "text", text: "hello world" } },
          }),
          envelope(TARGET, { type: "session.idle", properties: { sessionID: "ses_upstream" } }),
        ].join(""), { headers: { "Content-Type": "text/event-stream" } })
      }
      if (url.pathname === "/session/ses_upstream/prompt_async") {
        userMessageId = (await request.json() as { messageID: string }).messageID
        return new Response(null, { status: 204 })
      }
      if (url.pathname === "/session/ses_upstream/message") {
        return Response.json([{
          info: { id: "msg_assistant", sessionID: "ses_upstream", role: "assistant", parentID: userMessageId, ...(streams > 1 ? { finish: "stop", time: { completed: 1 } } : {}) },
          parts: [{ id: "part_1", messageID: "msg_assistant", sessionID: "ses_upstream", type: "text", text: streams > 1 ? "hello world" : "hello" }],
        }])
      }
      if (url.pathname === "/session/status") return Response.json(streams > 1 ? {} : { ses_upstream: { type: "busy" } })
      if (url.pathname === "/session/ses_upstream") return Response.json({ id: "ses_upstream", directory: TARGET })
      return new Response("missing", { status: 404 })
    })
    const adapter = await connect({ descriptor: descriptor(baseUrl) })

    const events = await collect(adapter.executeTurn(binding(), prompt()))
    expect(events.filter((event) => event.type === "text-delta").map((event) => event.delta).join("")).toBe("hello world")
    expect(events.filter((event) => event.type !== "text-delta")).toEqual([{ type: "finish", sessionId: "claxedo_ses_1" }])
    expect(events.at(-1)).toEqual({ type: "finish", sessionId: "claxedo_ses_1" })
    expect(lastEventIds).toEqual([null, null])
  })

  test("rejects a session-bearing global event that omits its workspace directory", async () => {
    const baseUrl = serve((request) => {
      const url = new URL(request.url)
      if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.2.3" })
      if (url.pathname.endsWith("/message")) return Response.json([])
      if (url.pathname === "/global/event") {
        return new Response(
          `data: ${JSON.stringify({ payload: { id: crypto.randomUUID(), type: "session.idle", properties: { sessionID: "ses_upstream" } } })}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        )
      }
      if (url.pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 })
      return new Response("missing", { status: 404 })
    })
    const adapter = await connect({ descriptor: descriptor(baseUrl) })

    await expect(collect(adapter.executeTurn(binding(), prompt()))).rejects.toMatchObject({ code: "invalid_event" })
  })

  test("returns a typed gap instead of stale success when authoritative reconciliation cannot scope status", async () => {
    const baseUrl = serve((request) => {
      const url = new URL(request.url)
      if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.2.3" })
      if (url.pathname === "/global/event") {
        return new Response(envelope(TARGET, {
          type: "message.part.updated",
          properties: { part: { id: "p", messageID: "m", sessionID: "ses_upstream", type: "text", text: "partial" } },
        }), { headers: { "Content-Type": "text/event-stream" } })
      }
      if (url.pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 })
      if (url.pathname.endsWith("/message")) return Response.json([])
      if (url.pathname === "/session/status") return Response.json({ foreign_session: { type: "idle" } })
      return new Response("missing", { status: 404 })
    })
    const adapter = await connect({ descriptor: descriptor(baseUrl) })

    await expect(collect(adapter.executeTurn(binding(), prompt()))).rejects.toMatchObject({ code: "reconciliation_gap" })
  })

  test("fails unsupported interactive events instead of yielding a request that cannot be answered", async () => {
    let aborts = 0
    const baseUrl = serve((request) => {
      const url = new URL(request.url)
      if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.2.3" })
      if (url.pathname.endsWith("/message")) return Response.json([])
      if (url.pathname === "/global/event") {
        return new Response(envelope(TARGET, {
          type: "permission.asked",
          properties: { id: "perm_1", sessionID: "ses_upstream", permission: "shell" },
        }), { headers: { "Content-Type": "text/event-stream" } })
      }
      if (url.pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 })
      if (url.pathname.endsWith("/abort")) {
        aborts += 1
        return Response.json(true)
      }
      return new Response("missing", { status: 404 })
    })
    const adapter = await connect({ descriptor: descriptor(baseUrl) })

    await expect(collect(adapter.executeTurn(binding(), prompt()))).rejects.toMatchObject({ code: "unsupported_interaction" })
    expect(aborts).toBe(1)
  })

  test.each([500, 404])("keeps observing the bound turn after remote abort returns HTTP %s", async (abortStatus) => {
    let promptAccepted!: () => void
    const prompted = new Promise<void>((resolve) => { promptAccepted = resolve })
    let events!: ReadableStreamDefaultController<Uint8Array>
    let userMessageId = ""
    let completed = false
    const baseUrl = serve(async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.2.3" })
      if (url.pathname.endsWith("/message")) return Response.json(completed ? [{
        info: { id: "msg_assistant", sessionID: "ses_upstream", role: "assistant", parentID: userMessageId, finish: "stop", time: { completed: 1 } },
        parts: [{ id: "part_1", messageID: "msg_assistant", sessionID: "ses_upstream", type: "text", text: "Still running" }],
      }] : [])
      if (url.pathname === "/session/status") return Response.json(completed ? {} : { ses_upstream: { type: "busy" } })
      if (url.pathname === "/session/ses_upstream") return Response.json({ id: "ses_upstream", directory: TARGET })
      if (url.pathname === "/global/event") {
        return new Response(new ReadableStream({
          start(controller) {
            events = controller
            controller.enqueue(new TextEncoder().encode(envelope(TARGET, { type: "server.connected", properties: {} })))
          },
        }), { headers: { "Content-Type": "text/event-stream" } })
      }
      if (url.pathname === "/session/ses_upstream/prompt_async") {
        userMessageId = (await request.json() as { messageID: string }).messageID
        promptAccepted()
        // Bun's fixture server rejects a reused bodyless POST while this SSE is open.
        return new Response(null, { status: 204, headers: { Connection: "close" } })
      }
      if (url.pathname === "/session/ses_upstream/todo") {
        return Response.json([{ content: "Run tests", status: "pending", priority: "high" }])
      }
      if (url.pathname === "/session/ses_upstream/abort") {
        return new Response("remote failed", { status: abortStatus })
      }
      return new Response("missing", { status: 404 })
    })
    const adapter = await connect({ descriptor: descriptor(baseUrl) })
    const stream = adapter.executeTurn(binding(), prompt())[Symbol.asyncIterator]()
    const next = stream.next()
    try {
      await prompted
      await expect(adapter.getTodos!(binding())).resolves.toEqual([{ content: "Run tests", status: "pending", priority: "high" }])
      if (abortStatus === 500) {
        await expect(adapter.abort!(binding())).rejects.toMatchObject({ code: "http_error", status: 500 })
      } else {
        await expect(adapter.abort!(binding())).resolves.toMatchObject({ ok: false, status: "not_found" })
      }
      completed = true
      events.enqueue(new TextEncoder().encode(envelope(TARGET, {
        type: "session.idle", properties: { sessionID: "ses_upstream" },
      })))
      await expect(next).resolves.toEqual({ done: false, value: { type: "text-delta", delta: "Still running" } })
      await expect(stream.next()).resolves.toEqual({ done: false, value: { type: "finish", sessionId: "claxedo_ses_1" } })
      await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
    } finally {
      await adapter.dispose()
      await stream.return?.()
    }
  })

  test("rejects cross-workspace bindings and does not fabricate session configuration", async () => {
    const adapter = await connect({ descriptor: descriptor("https://opencode.example.test") })
    await expect(adapter.getSession(binding({ directory: "/local/other" }))).rejects.toMatchObject({ code: "invalid_directory" })
    await expect(adapter.getSession(binding({ connectionId: "connection:other" }))).rejects.toMatchObject({ code: "invalid_binding" })
    // @ts-expect-error Exercise runtime rejection of the retired execution scope.
    await expect(adapter.getSession({ scope: "central", directory: "", sessionId: "central", connectionId: "connection:external-opencode", upstreamSessionId: "ses_upstream" })).rejects.toMatchObject({ code: "invalid_binding" })
    await expect(adapter.getSessionConfig(binding())).rejects.toMatchObject({ code: "unsupported_operation" })
    await expect(adapter.updateSessionConfig(binding(), { agent: "build" })).rejects.toMatchObject({ code: "unsupported_operation" })
  })

  test("refuses a stored message whose nested wire values the contract does not describe", async () => {
    const identity = { id: "part_1", messageID: "msg_assistant", sessionID: "ses_upstream" }
    const malformed = [
      { id: "part_1", messageID: "msg_assistant", sessionID: "ses_upstream", type: "file", mime: "image/png", url: "javascript:alert(1)" },
      { ...identity, type: "tool", callID: "call_1", tool: "read", state: { status: "completed", input: {}, output: "done", title: "read", metadata: {}, time: { start: 1, end: 2 }, attachments: [{}] } },
    ]
    for (const part of malformed) {
      const baseUrl = serve((request) => {
        const url = new URL(request.url)
        if (url.pathname === "/session/ses_upstream/message") {
          return Response.json([{ info: { id: "msg_assistant", sessionID: "ses_upstream", role: "assistant" }, parts: [part] }])
        }
        return new Response("missing", { status: 404 })
      })
      const adapter = await connect({ descriptor: descriptor(baseUrl) })
      await expect(adapter.getMessages(binding())).rejects.toMatchObject({ code: "invalid_response" })
    }
  })

  test("truthfully advertises only bound operations", async () => {
    const adapter = await connect({ descriptor: descriptor("https://opencode.example.test") })
    expect(adapter.readHarnessCapabilities(SOURCE)).toEqual({
      harness: "external-opencode",
      modelSelection: { status: "unsupported" },
      abort: true,
      reconnect: true,
      replay: false,
      permissions: false,
      questions: false,
      todos: true,
      commands: false,
      fork: false,
      revert: false,
      unrevert: false,
      configOptions: false,
      subagents: false,
      goals: false,
      effortLevels: NO_HARNESS_EFFORT,
      instructionChannel: "none",
    })
    expect(adapter).not.toHaveProperty("listSessions")
    expect(adapter).not.toHaveProperty("discoverSessions")
    await expect((adapter.abort as unknown as (value: string) => Promise<unknown>)("ses_upstream")).rejects.toMatchObject({ code: "invalid_binding" })
    await expect((adapter.getTodos as unknown as (value: string) => Promise<unknown>)("ses_upstream")).rejects.toMatchObject({ code: "invalid_binding" })
  })
})
