import { afterEach, expect, test } from "bun:test"
import { createClientPresentationProjection } from "@claxedo/agent-event-runtime/client-presentation"
import type { AgentExecutionBinding, PromptInput } from "@claxedo/agent-runtime-contract"
import { createOpenCodeServerConnectionProvider } from "./index"
import { OpenCodeServerAdapter } from "./adapter"

const servers: Bun.Server<unknown>[] = []
afterEach(() => { for (const server of servers.splice(0)) server.stop(true) })
const binding: AgentExecutionBinding = { workspaceId: "ws", directory: "/local", sessionId: "local-session", connectionId: "connection:remote", upstreamSessionId: "ses_remote" }
const prompt: PromptInput = { userMessageId: "msg_local_not_sortable", assistantMessageId: "local-reply", agent: "build", model: { providerID: "default", modelID: "default" }, parts: [{ type: "text", text: "hello" }] }

function message(id: string, parentID: string, text: string, completed = true) {
  return {
    info: { id, parentID, sessionID: "ses_remote", role: "assistant", time: { created: 1, ...(completed ? { completed: 2 } : {}) }, ...(completed ? { finish: "stop" } : {}) },
    parts: [{ type: "text", id: `prt_${id}`, messageID: id, sessionID: "ses_remote", text }],
  }
}

function event(type: string, properties: Record<string, unknown>) {
  return { type, properties }
}

async function run(input: {
  frames?: (userId: string) => ReturnType<typeof event>[]
  reconnectFrames?: (userId: string) => ReturnType<typeof event>[]
  previousMessages?: unknown[]
  messages: (userId: string) => unknown
  statuses: unknown
  session?: unknown
}) {
  let userId = ""
  let prompts = 0
  let connections = 0
  let sink: ReadableStreamDefaultController<Uint8Array>
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/global/health") return Response.json({ healthy: true, version: "1.2.3" })
    if (path === "/global/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      connections++
      sink = controller
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ payload: { id: "connected", type: "server.connected", properties: {} } })}\n\n`))
      if (connections > 1) {
        for (const frame of input.reconnectFrames?.(userId) ?? []) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ directory: "/remote", payload: { id: crypto.randomUUID(), ...frame } })}\n\n`))
        }
        controller.close()
      }
    } }), { headers: { "content-type": "text/event-stream" } })
    if (path.endsWith("/prompt_async")) {
      prompts++
      userId = (await request.json() as { messageID: string }).messageID
      for (const frame of input.frames?.(userId) ?? []) {
        sink.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ directory: "/remote", payload: { id: crypto.randomUUID(), ...frame } })}\n\n`))
      }
      sink.close()
      return new Response(null, { status: 204 })
    }
    if (path.endsWith("/message")) return Response.json(userId ? input.messages(userId) : input.previousMessages ?? [])
    if (path === "/session/status") return Response.json(typeof input.statuses === "function" ? input.statuses() : input.statuses)
    if (path === "/session/ses_remote") return input.session === null ? new Response(null, { status: 404 }) : Response.json(input.session ?? { id: "ses_remote", directory: "/remote" })
    return new Response(null, { status: 404 })
  } })
  servers.push(server)
  const provider = createOpenCodeServerConnectionProvider()
  const descriptor = { connectionId: "remote", providerKey: provider.providerKey, configRevision: 1, enabled: true, config: provider.validateConfig({ label: "remote", baseUrl: `http://127.0.0.1:${server.port}`, workspacePaths: [{ sourceDirectory: "/local", targetDirectory: "/remote" }], reconnect: { maxAttempts: input.reconnectFrames ? 1 : 0, delayMs: 0 } }) }
  const resolved = await provider.resolve({ descriptor, directory: "/local", secrets: {} })
  const adapter = provider.createAdapter({ descriptor, resolved, context: {} as never })
  if (!(adapter instanceof OpenCodeServerAdapter)) throw new Error("Provider returned a different adapter")
  const events = []
  try {
    for await (const value of adapter.executeTurn!(binding, prompt)) events.push(value)
  } finally { adapter.dispose() }
  return { events, userId, prompts }
}

test("reconciles only this prompt's answer and finishes when OpenCode removes idle status", async () => {
  const result = await run({ messages: (id) => [message("msg_old", "msg_previous", "old answer"), message("msg_new", id, "new answer")], statuses: {} })
  expect(result.events).toEqual([{ type: "text-delta", delta: "new answer" }, { type: "finish", sessionId: "local-session" }])
  expect(result.prompts).toBe(1)
  expect(result.userId).not.toBe(prompt.userMessageId)
  expect(result.userId).toStartWith("msg_")
})

test("filters old live message events and projects wire deltas and named tools through the canonical UI projector", async () => {
  const tool = { type: "tool", id: "prt_tool", messageID: "msg_new", sessionID: "ses_remote", tool: "read", callID: "read_1" }
  const completedTool = { ...tool, state: { status: "completed", input: { filePath: "/remote/a.ts" }, output: "source", metadata: { preview: "source" } } }
  const result = await run({
    frames(id) {
      const current = message("msg_new", id, "hello")
      const old = message("msg_old", "msg_previous", "old")
      const text = current.parts[0]!
      return [
        event("message.updated", { info: old.info }), event("message.part.updated", { part: old.parts[0] }),
        event("message.updated", { info: current.info }),
        event("message.part.updated", { part: { ...text, text: "" } }),
        event("message.part.delta", { sessionID: "ses_remote", messageID: "msg_new", partID: text.id, field: "text", delta: "hello" }),
        event("message.part.updated", { part: text }),
        event("message.part.updated", { part: { ...tool, state: { status: "running", input: { filePath: "/remote/a.ts" } } } }),
        event("message.part.updated", { part: completedTool }),
        event("session.idle", { sessionID: "ses_remote" }),
      ]
    }, messages: (id) => [
      { ...message("msg_new", id, "hello"), parts: [...message("msg_new", id, "hello").parts, completedTool] },
      { ...message("msg_z", id, ""), parts: [] },
    ], statuses: {},
  })
  expect(result.events.filter((item) => item.type === "text-delta")).toEqual([{ type: "text-delta", delta: "hello" }])
  const projection = createClientPresentationProjection({ sessionId: "local-session", directory: "/local", assistantMessageId: "local-reply", clock: () => 100 })
  const projected = result.events.flatMap((item) => projection.ingest(item))
  const tools = projected.filter((item) => item.payload.type === "message.part.updated" && item.payload.properties.part.type === "tool")
  expect(tools.at(-1)?.payload).toMatchObject({ properties: { part: { tool: "read", state: { status: "completed", input: { filePath: "/remote/a.ts" }, output: "source", metadata: { preview: "source" } } } } })
})

test("recovers a new assistant step whose message event was missed before the idle notification", async () => {
  const result = await run({
    frames(id) {
      const first = message("msg_1", id, "first step", false)
      return [event("message.updated", { info: first.info }), event("message.part.updated", { part: first.parts[0] }), event("session.idle", { sessionID: "ses_remote" })]
    },
    messages: (id) => [message("msg_1", id, "first step"), message("msg_2", id, "final answer")],
    statuses: {},
  })
  expect(result.events).toEqual([{ type: "text-delta", delta: "first step" }, { type: "text-delta", delta: "final answer" }, { type: "finish", sessionId: "local-session" }])
})

test.each(["missing", "overlapping"])("reconciles authoritative text with %s deltas around SSE reconnect", async (gap) => {
  let reconnected = false
  const result = await run({
    frames(id) {
      const current = message("msg_new", id, "hello", false)
      return [event("message.updated", { info: current.info }), event("message.part.updated", { part: current.parts[0] })]
    },
    reconnectFrames(id) {
      reconnected = true
      const current = message("msg_new", id, "hello there world")
      return [
        ...(gap === "overlapping" ? [
          event("message.part.updated", { part: { ...current.parts[0], text: "hello" } }),
          event("message.part.delta", { sessionID: "ses_remote", messageID: "msg_new", partID: current.parts[0]!.id, field: "text", delta: " there" }),
        ] : []),
        event("message.part.delta", { sessionID: "ses_remote", messageID: "msg_new", partID: current.parts[0]!.id, field: "text", delta: " world" }),
        event("message.part.updated", { part: current.parts[0] }),
        event("session.idle", { sessionID: "ses_remote" }),
      ]
    },
    messages: (id) => [message("msg_new", id, reconnected ? "hello there world" : gap === "overlapping" ? "hello there" : "hello", reconnected)],
    statuses: () => reconnected ? {} : { ses_remote: { type: "busy" } },
  })
  expect(result.events.filter((item) => item.type === "text-delta").map((item) => item.delta).join("")).toBe("hello there world")
  expect(result.events.at(-1)).toEqual({ type: "finish", sessionId: "local-session" })
  expect(result.prompts).toBe(1)
})

test.each(["reconnect", "heartbeats", "busy heartbeats"] as const)("observes completion despite a missed idle event during %s", async (scenario) => {
  let userId = ""
  let prompts = 0
  let connections = 0
  let completed = false
  let messageReads = 0
  let liveText = scenario === "busy heartbeats" ? "finished" : "finished without idle"
  let sink!: ReadableStreamDefaultController<Uint8Array>
  const snapshotConnections: number[] = []
  const heartbeatTimers = new Set<ReturnType<typeof setInterval>>()
  const frame = (payload = event("server.heartbeat", {})) => new TextEncoder().encode(`data: ${JSON.stringify({ directory: "/remote", payload: { id: crypto.randomUUID(), ...payload } })}\n\n`)
  const server = Bun.serve({ port: 0, async fetch(request) {
    const pathname = new URL(request.url).pathname
    if (pathname === "/global/health") return Response.json({ healthy: true, version: "1.2.3" })
    if (pathname === "/global/event") {
      connections++
      // This completion falls in the old snapshot-before-resubscribe gap.
      if (connections === 2) completed = true
      let heartbeat: ReturnType<typeof setInterval> | undefined
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          sink = controller
          controller.enqueue(frame())
          if (scenario !== "reconnect" || connections > 1) {
            heartbeat = setInterval(() => controller.enqueue(frame()), 5)
            heartbeatTimers.add(heartbeat)
          }
        },
        cancel() {
          if (heartbeat) { clearInterval(heartbeat); heartbeatTimers.delete(heartbeat) }
        },
      }), { headers: { "content-type": "text/event-stream" } })
    }
    if (pathname.endsWith("/prompt_async")) {
      prompts++
      userId = (await request.json() as { messageID: string }).messageID
      if (scenario === "reconnect") sink.close()
      else if (scenario === "busy heartbeats") {
        const current = message("msg_new", userId, liveText, false)
        sink.enqueue(frame(event("message.updated", { info: current.info })))
        sink.enqueue(frame(event("message.part.updated", { part: current.parts[0] })))
      }
      else completed = true
      return new Response(null, { status: 204 })
    }
    if (pathname === "/session/status") {
      snapshotConnections.push(connections)
      if (scenario === "busy heartbeats" && snapshotConnections.length === 1) {
        liveText += " without idle"
        sink.enqueue(frame(event("message.part.delta", { sessionID: "ses_remote", messageID: "msg_new", partID: "prt_msg_new", field: "text", delta: " without idle" })))
      }
      return Response.json(completed ? {} : { ses_remote: { type: "busy" } })
    }
    if (pathname.endsWith("/message")) {
      messageReads++
      return Response.json(userId ? [message("msg_new", userId, liveText, completed)] : [])
    }
    if (pathname === "/session/ses_remote") return Response.json({ id: "ses_remote", directory: "/remote" })
    return new Response(null, { status: 404 })
  } })
  servers.push(server)
  const provider = createOpenCodeServerConnectionProvider()
  const descriptor = {
    connectionId: "remote", providerKey: provider.providerKey, configRevision: 1, enabled: true,
    config: provider.validateConfig({
      label: "remote", baseUrl: `http://127.0.0.1:${server.port}`,
      workspacePaths: [{ sourceDirectory: "/local", targetDirectory: "/remote" }],
      reconnect: { maxAttempts: 1, delayMs: 0 }, deadlines: { requestMs: 500, streamIdleMs: 50 },
    }),
  }
  const resolved = await provider.resolve({ descriptor, directory: "/local", secrets: {} })
  const adapter = provider.createAdapter({ descriptor, resolved, context: {} as never })
  const observed: unknown[] = []
  const collect = (async () => {
    for await (const value of adapter.executeTurn!(binding, prompt)) {
      observed.push(value)
      if (scenario === "busy heartbeats" && value.type === "text-delta" && value.delta === " without idle") {
        // A healthy stream must still deliver live deltas; periodic busy checks
        // must not read history and force the turn into snapshot-only recovery.
        expect(messageReads).toBe(1)
        completed = true
      }
    }
  })()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([collect, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Completed turn remained busy while heartbeats continued")), 1_000)
    })])
    expect(observed).toEqual([
      ...(scenario === "busy heartbeats"
        ? [{ type: "text-delta", delta: "finished" }, { type: "text-delta", delta: " without idle" }]
        : [{ type: "text-delta", delta: "finished without idle" }]),
      { type: "finish", sessionId: "local-session" },
    ])
    expect(prompts).toBe(1)
    expect(connections).toBe(scenario === "reconnect" ? 2 : 1)
    expect(snapshotConnections[0]).toBe(connections)
  } finally {
    if (timeout) clearTimeout(timeout)
    for (const timer of heartbeatTimers) clearInterval(timer)
    await adapter.dispose()
    await collect.catch(() => undefined)
  }
})

test.each([
  ["unfinished answer", (id: string) => [message("msg_new", id, "partial", false)], {}, undefined],
  ["only an old answer", () => [message("msg_old", "msg_previous", "old")], {}, undefined],
  ["missing session", (id: string) => [message("msg_new", id, "answer")], {}, null],
  ["malformed statuses", (id: string) => [message("msg_new", id, "answer")], [], undefined],
  ["active session", (id: string) => [message("msg_new", id, "answer")], { ses_remote: { type: "busy" } }, undefined],
  ["retrying session", (id: string) => [message("msg_new", id, "answer")], { ses_remote: { type: "retry", attempt: 1, next: 123, message: "retrying" } }, undefined],
  ["newer unfinished step", (id: string) => [message("msg_1", id, "step one"), message("msg_2", id, "step two", false)], {}, undefined],
  ["tool step awaiting continuation", (id: string) => [{ ...message("msg_new", id, "working"), info: { ...message("msg_new", id, "working").info, finish: "tool-calls" } }], {}, undefined],
] as const)("does not report success with %s", async (_, messages, statuses, session) => {
  await expect(run({ messages, statuses, session })).rejects.toMatchObject({ code: "reconciliation_gap" })
})

test("reconciles an authoritative current-turn error without calling it success", async () => {
  const result = await run({ messages: (id) => [{ ...message("msg_new", id, "partial"), info: { ...message("msg_new", id, "partial").info, error: { data: { message: "model failed" } } } }], statuses: {} })
  expect(result.events.at(-1)).toEqual({ type: "error", error: "model failed" })
  expect(result.events.some((item) => item.type === "finish")).toBe(false)
})

test.each([-3_600_000, 3_600_000])("orders prompts between remote messages with %d milliseconds of clock skew", async (skew) => {
  const remoteTime = BigInt.asUintN(48, BigInt(Date.now() + skew) * 0x1000n)
  const remoteId = (offset: bigint) => `msg_${(remoteTime + offset).toString(16).padStart(12, "0")}${"a".repeat(14)}`
  const previous = message(remoteId(1n), "msg_previous", "old answer")
  const answerId = remoteId(2n)
  const result = await run({
    previousMessages: [previous],
    messages: (userId) => [previous, ...(userId > previous.info.id && userId < answerId ? [message(answerId, userId, "new answer")] : [])],
    statuses: {},
  })
  expect(result.userId > previous.info.id).toBe(true)
  expect(result.userId < answerId).toBe(true)
  expect(result.events).toEqual([{ type: "text-delta", delta: "new answer" }, { type: "finish", sessionId: "local-session" }])
})

test("repeated failed turns stay ordered without growing their message IDs", async () => {
  const history: Array<{ info: { id: string; sessionID: string; role: string }; parts: unknown[] }> = []
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await run({
      previousMessages: history,
      frames: () => [event("session.error", { sessionID: "ses_remote", error: { message: "cancelled upstream" } })],
      messages: () => history,
      statuses: {},
    })
    expect(result.events.at(-1)).toEqual({ type: "error", error: "cancelled upstream" })
    if (history.length) {
      expect(result.userId > history.at(-1)!.info.id).toBe(true)
      expect(result.userId.length).toBe(history[0]!.info.id.length)
    }
    history.push({ info: { id: result.userId, sessionID: "ses_remote", role: "user" }, parts: [] })
  }
  const remoteId = `msg_${BigInt.asUintN(48, BigInt(Date.now()) * 0x1000n).toString(16).padStart(12, "0")}${"a".repeat(14)}`
  const recovered = await run({ previousMessages: history, messages: (id) => [message(remoteId, id, "recovered")], statuses: {} })
  expect(recovered.userId > history.at(-1)!.info.id).toBe(true)
  expect(recovered.userId < remoteId).toBe(true)
  expect(recovered.events.at(-1)).toEqual({ type: "finish", sessionId: "local-session" })
})

test("rejects reconciliation messages from another upstream session", async () => {
  await expect(run({ messages: (id) => [{ ...message("msg_new", id, "foreign"), info: { ...message("msg_new", id, "foreign").info, sessionID: "ses_other" } }], statuses: {} })).rejects.toMatchObject({ code: "invalid_response" })
})

test("rejects reconciliation parts attached to another message", async () => {
  await expect(run({ messages: (id) => [{ ...message("msg_new", id, "answer"), parts: message("msg_other", id, "foreign").parts }], statuses: {} })).rejects.toMatchObject({ code: "invalid_response" })
})
