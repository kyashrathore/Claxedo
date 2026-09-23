import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { createSessionRoutes } from "./session-core"
import { createSessionDeliveryOwner, type SessionDeliveryOwner } from "../session/delivery-owner"
import type { AgentRuntime, AgentRuntimeTurnStartInput, PromptDelivery } from "@claxedo/agent-sdk-runtime"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import { runRuntimePromptTurn } from "../session/service"
import { sessionIdle } from "../compat-events"
import type { SessionAccessPolicy, SessionTurnGrantDecision } from "../session-access-policy"
import { RuntimeStore, type QueuedPromptRecord } from "../store"
import { createAgentRuntime } from "@claxedo/agent-sdk-runtime"
import { createMemoryRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/memory"
import { createRuntimeEventHub } from "@claxedo/agent-sdk-runtime/runtime-event-hub"

const roots: string[] = []
const stores: RuntimeStore[] = []
const owners: SessionDeliveryOwner[] = []
const runtimes = new WeakMap<SessionDeliveryOwner, (runtime: AgentRuntime) => void>()

afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.dispose()
  for (const store of stores.splice(0)) store.close()
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function storeRoot() {
  const root = mkdtempSync(join(tmpdir(), "wr-prompt-delivery-"))
  roots.push(root)
  return root
}

function adapter(): AgentHarnessAdapter {
  return {
    instructionChannel: "none",
    getSession: async (binding) => ({ id: binding.sessionId }),
    createSession: async () => ({ id: "session_1" }),
    updateSession: async (binding) => ({ id: binding.sessionId }),
    getSessionConfig: async () => ({
      harness: { id: "codex", access: "native" },
      model: { providerID: "test", modelID: "fixture" },
      agent: "build",
      variant: null,
    }),
    updateSessionConfig: async (_binding, patch) => ({
      harness: patch.harness ?? { id: "codex", access: "native" },
      agent: null,
      variant: null,
    }),
    deleteSession: async () => {},
    readHarnessCapabilities: () => ({ harness: "codex", abort: true }) as never,
    executeTurn: () => (async function* () {})(),
    getMessages: async () => [],
    cancelTurn: async () => ({ execution: "terminal" as const, cleanup: "verified_clear" as const }),
    dispose: () => {},
  }
}

function runtimeDouble(input: {
  starts: AgentRuntimeTurnStartInput[]
  deliveries: PromptDelivery[]
  idle?: () => Promise<void>
  refuse?: (attempt: number) => Error | undefined
  abandons?: number[]
}) {
  return {
    turns: {
      start: async (turn: AgentRuntimeTurnStartInput) => {
        const refusal = input.refuse?.(input.starts.length + 1)
        if (refusal) throw refusal
        input.starts.push(turn)
        const delivery = input.deliveries.shift() ?? "start"
        return {
          sessionId: turn.sessionId,
          userMessageId: turn.messageId ?? "user_1",
          assistantMessageId: "assistant_1",
          directory: undefined,
          delivery,
          ...(turn.delivery === "steer" ? { steering: delivery === "steer" ? { ok: true } : { ok: false, status: "declined", message: "Provider declined steering" } } : {}),          prompt: {
            parts: turn.parts ?? [],
            userMessageId: turn.messageId ?? "user_1",
            assistantMessageId: "assistant_1",
            agent: "build",
            model: { providerID: "test", modelID: "fixture" },
          },
        }
      },
      whenIdle: async () => {
        await (input.idle?.() ?? Promise.resolve())
        return { abandon: () => input.abandons?.push(input.starts.length) }
      },
    },
    events: {
      subscribe: () => (async function* () {
        yield { sessionId: "session_1", directory: undefined, payload: sessionIdle("session_1") }
      })(),
      list: async () => [],
    },
  } as unknown as AgentRuntime
}

function routes(runtime: AgentRuntime, queuedPrompts = durableQueue().host, published: unknown[] = [], policy?: SessionAccessPolicy) {
  runtimes.get(queuedPrompts)?.(runtime)
  return createSessionRoutes({
    resolveAdapter: () => adapter(),
    resolveRuntime: () => runtime,
    resolveDirectory: () => undefined,
    publishGlobal: (event) => { published.push(event) },
    ...(queuedPrompts ? { queuedPrompts } : {}),
    ...(policy ? { sessionAccessPolicy: policy } : {}),
  })
}

const RELAYED_ACTOR = { actorId: "actor_1", actorKind: "human" as const }
const RELAYED_AUTHORITY = { managed: true as const, workspaceId: "ws_1", orgId: "org_1", role: "editor" as const }

/**
 * The routes behind a plane that mints deferred grants for queued input. With
 * `relayed`, every request arrives as the relay stamps it; without, as the
 * machine's own user over loopback.
 */
function grantingRoutes(runtime: AgentRuntime, queuedPrompts: SessionDeliveryOwner, input: {
  relayed: boolean
  grant: (request: Parameters<NonNullable<SessionAccessPolicy["grantTurn"]>>[0]) => SessionTurnGrantDecision
}) {
  const granted: Array<Parameters<NonNullable<SessionAccessPolicy["grantTurn"]>>[0]> = []
  const notStarted = { allowed: false as const, status: 403 as const, code: "startup_not_tested", message: "Startup is not admitted by this fixture" }
  const policy: SessionAccessPolicy = {
    sessionAuthority: "managed-private",
    authorize: () => ({ allowed: true }),
    authorizePrefix: () => ({ allowed: true }),
    filterSessions: (request) => request.sessionIds,
    authorizeSessionStartStatus: () => notStarted,
    authorizeSessionStart: () => notStarted,
    grantTurn: (request) => {
      granted.push(request)
      return input.grant(request)
    },
  }
  const app = new Hono()
  if (input.relayed) {
    app.use("*", async (c, next) => {
      c.set("relayHostAuth" as never, {
        workspace_id: RELAYED_AUTHORITY.workspaceId,
        org_id: RELAYED_AUTHORITY.orgId,
        role: RELAYED_AUTHORITY.role,
        actor_id: RELAYED_ACTOR.actorId,
        actor_kind: RELAYED_ACTOR.actorKind,
      } as never)
      await next()
    })
  }
  app.route("/", routes(runtime, queuedPrompts, [], policy))
  return { app, granted }
}

/** Every row the durable queue wrote, kept past the moment its turn starts and the row is dropped. */
function persistedRows(queue: ReturnType<typeof durableQueue>) {
  const rows: QueuedPromptRecord[] = []
  const write = queue.store.queuePrompt.bind(queue.store)
  queue.store.queuePrompt = (record) => {
    const row = write(record)
    rows.push(row)
    return row
  }
  return rows
}

function relayedPrompt(body: Record<string, unknown>) {
  return { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer signed-rht" }, body: JSON.stringify(body) }
}

/** The durable queue the host lends the routes, on a real store. */
function durableQueue() {
  const store = new RuntimeStore(storeRoot())
  stores.push(store)
  const recoveries: string[] = []
  let runtime!: AgentRuntime
  const host = createSessionDeliveryOwner({
    store: () => ({
      queuePrompt: (input) => store.queuePrompt(input),
      deleteQueuedPrompt: (sessionId, seq) => store.deleteQueuedPrompt(sessionId, seq),
      replaceQueuedPromptParts: (sessionId, seq, parts) => store.replaceQueuedPromptParts(sessionId, seq, parts),
      listQueuedPrompts: () => store.listQueuedPrompts(),
      claimQueuedPromptDelivery: (sessionId, seq, operationId, mode) => store.claimQueuedPromptDelivery(sessionId, seq, operationId, mode),
      settleQueuedPromptDelivery: (sessionId, seq, steering) => store.settleQueuedPromptDelivery(sessionId, seq, steering),
      setQueuedPromptHeld: (sessionId, seq, held) => store.setQueuedPromptHeld(sessionId, seq, held),
      completeQueuedPrompt: (sessionId, seq, operationId) => store.completeQueuedPrompt(sessionId, seq, operationId),
      sessionDirectory: () => "/workspace",
    }),
    whenIdle: (sessionId) => runtime.turns.whenIdle(sessionId),
    startTurn: (input) => new Promise<void>((resolve, reject) => {
      void runRuntimePromptTurn({ ...input, runtime, publishGlobal: () => {}, onAdmissionSettled: (error) => error ? reject(error) : resolve() }).catch(reject)
    }),
  })
  owners.push(host)
  runtimes.set(host, (value) => { runtime = value })
  return { store, recoveries, host }
}

function prompt(body: Record<string, unknown>) {
  return { method: "POST", body: JSON.stringify(body) }
}

test("acceptance after the original turn finishes remains visible without inventing a transcript position", async () => {
  const queue = durableQueue()
  const eventHub = createRuntimeEventHub()
  let finish!: () => void
  let accept!: () => void
  let dispatched!: () => void
  let publishedIdle!: () => void
  const completion = new Promise<void>((resolve) => { finish = resolve })
  const acknowledgement = new Promise<void>((resolve) => { accept = resolve })
  const dispatch = new Promise<void>((resolve) => { dispatched = resolve })
  const idle = new Promise<void>((resolve) => { publishedIdle = resolve })
  const provider: AgentHarnessAdapter = {
    ...adapter(),
    async *executeTurn(binding) { await completion; yield sessionIdle(binding.sessionId) },
    async steerTurn() { dispatched(); await acknowledgement; return { ok: true } },
  }
  const runtime = createAgentRuntime({
    store: createMemoryRuntimeStore(), eventHub,
    harnesses: [{ id: "codex", access: "native", create: () => provider }],
  })
  await runtime.sessions.create({ id: "session_1", workspaceId: "workspace", directory: "/workspace", harness: { id: "codex", access: "native" } })
  const userIds: string[] = []
  const unsubscribe = eventHub.subscribeGlobal(({ payload }) => {
    if (payload.type === "session.idle") publishedIdle()
    if (payload.type === "message.updated" && payload.properties.info.role === "user") userIds.push(payload.properties.info.id)
  })
  try {
    const app = routes(runtime, queue.host)
    await app.request("http://localhost/session/session_1/prompt_async", prompt({ messageID: "opening", parts: [{ type: "text", text: "work" }] }))
    await app.request("http://localhost/session/session_1/prompt_async", prompt({ messageID: "late-ack", delivery: "queue", parts: [{ type: "text", text: "S" }] }))
    const seq = queue.host.list("session_1")[0].seq
    const response = app.request(`http://localhost/session/session_1/queue/${seq}/steer`, { method: "POST" })
    await dispatch
    finish()
    await idle
    accept()
    expect((await response).status).toBe(200)
    expect(queue.host.list("session_1")[0]).toMatchObject({ messageId: "late-ack", steering: { state: "accepted" } })
    expect(userIds).toEqual(["opening"])
    expect((await runtime.events.list("session_1", "/workspace")).filter((message) => message.info.role === "user").map((message) => message.info.id)).toEqual(["opening"])
  } finally {
    finish(); accept(); unsubscribe()
    await runtime.dispose()
  }
})

test("two Steer requests observe one dispatch and neither succeeds before acceptance", async () => {
  const queue = durableQueue()
  const starts: AgentRuntimeTurnStartInput[] = []
  const runtime = runtimeDouble({ starts, deliveries: ["steer"], idle: () => new Promise(() => {}) })
  const start = runtime.turns.start.bind(runtime.turns)
  let accept!: () => void
  const acceptance = new Promise<void>((resolve) => { accept = resolve })
  let dispatches = 0
  runtime.turns.start = async (input) => {
    if (input.delivery === "steer") { dispatches++; await acceptance }
    return start(input)
  }
  const app = routes(runtime, queue.host)
  await app.request("http://localhost/session/session_1/prompt_async", prompt({ messageID: "pending", delivery: "queue", parts: [{ type: "text", text: "S" }] }))
  const seq = queue.host.list("session_1")[0].seq
  const url = `http://localhost/session/session_1/queue/${seq}/steer`
  let responses = 0
  const first = Promise.resolve(app.request(url, { method: "POST" })).then((response) => { responses++; return response })
  const second = Promise.resolve(app.request(url, { method: "POST" })).then((response) => { responses++; return response })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(dispatches).toBe(1)
  expect(responses).toBe(0)
  expect(queue.host.list("session_1")[0].steering?.state).toBe("dispatching")
  accept()
  expect((await first).status).toBe(200)
  expect((await second).status).toBe(200)
  expect(queue.host.list("session_1")[0].steering?.state).toBe("accepted")
})

test("a lost receipt remains unknown and cannot resend, edit, cancel, or start on idle", async () => {
  const queue = durableQueue()
  const starts: AgentRuntimeTurnStartInput[] = []
  let idle!: () => void
  const idleGate = new Promise<void>((resolve) => { idle = resolve })
  const runtime = runtimeDouble({ starts, deliveries: ["queue"], idle: () => idleGate })
  const start = runtime.turns.start.bind(runtime.turns)
  runtime.turns.start = async (input) => {
    const result = await start(input)
    return input.delivery === "steer" ? { ...result, steering: { ok: false, status: "unknown", message: "Connection lost after dispatch" } } : result
  }
  const app = routes(runtime, queue.host)
  await app.request("http://localhost/session/session_1/prompt_async", prompt({ messageID: "uncertain", delivery: "queue", parts: [{ type: "text", text: "S" }] }))
  const seq = queue.host.list("session_1")[0].seq
  const url = `http://localhost/session/session_1/queue/${seq}`
  const response = await app.request(`${url}/steer`, { method: "POST" })
  expect(response.status).toBe(202)
  expect(await response.json()).toMatchObject({ ok: false, status: "unknown" })
  expect((await app.request(`${url}/steer`, { method: "POST" })).status).toBe(202)
  expect((await app.request(`${url}/cancel`, { method: "POST" })).status).toBe(423)
  expect((await app.request(`${url}/replace`, prompt({ parts: [{ type: "text", text: "replacement" }] }))).status).toBe(423)
  idle()
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(starts).toHaveLength(1)
  expect(queue.host.list("session_1")[0].steering?.state).toBe("unknown")
})

test("an explicit refusal reaches HTTP and preserves the queue", async () => {
  const queue = durableQueue()
  const starts: AgentRuntimeTurnStartInput[] = []
  const app = routes(runtimeDouble({ starts, deliveries: ["queue"], idle: () => new Promise(() => {}) }), queue.host)
  await app.request("http://localhost/session/session_1/prompt_async", prompt({ messageID: "refused", delivery: "queue", parts: [{ type: "text", text: "S" }] }))
  const seq = queue.host.list("session_1")[0].seq
  const response = await app.request(`http://localhost/session/session_1/queue/${seq}/steer`, { method: "POST" })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({
    ok: false,
    status: "rejected",
    message: "Provider declined steering",
    error: { code: "queue_rejected", message: "Provider declined steering" },
  })
  expect(queue.host.list("session_1")[0].messageId).toBe("refused")
})

describe("how a prompt for a busy session is delivered", () => {
  test("a prompt asking to steer carries that to the runtime and answers with what happened", async () => {
    const starts: AgentRuntimeTurnStartInput[] = []
    const response = await routes(runtimeDouble({ starts, deliveries: ["steer"] }), durableQueue().host)
      .request("http://localhost/session/session_1/prompt_async", prompt({
        messageID: "msg_steer",
        parts: [{ type: "text", text: "also update the readme" }],
        delivery: "steer",
      }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ delivery: "steer" })
    expect(starts.map((turn) => turn.delivery)).toEqual(["steer"])
  })

  test("a queued prompt is acknowledged as queued and started once the session frees up", async () => {
    const starts: AgentRuntimeTurnStartInput[] = []
    let release!: () => void
    const idle = new Promise<void>((resolve) => { release = resolve })
    const response = await routes(runtimeDouble({
      starts,
      deliveries: ["start"],
      idle: () => idle,
    })).request("http://localhost/session/session_1/prompt_async", prompt({
      messageID: "msg_queued",
      parts: [{ type: "text", text: "then run the tests" }],
      delivery: "queue",
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ delivery: "queue" })
    expect(starts).toHaveLength(0)
    release()
    for (let attempt = 0; attempt < 200 && starts.length < 1; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(starts.map((turn) => turn.messageId)).toEqual(["msg_queued"])
  })

  test("a queued prompt whose start fails gives the session up for the next waiter", async () => {
    const starts: AgentRuntimeTurnStartInput[] = []
    const abandons: number[] = []
    const runtime = runtimeDouble({
      starts,
      deliveries: ["queue"],
      refuse: (attempt) => attempt === 1 ? new Error("the runtime has no adapter for this session") : undefined,
      abandons,
    })

    const response = await routes(runtime).request("http://localhost/session/session_1/prompt_async", prompt({
      messageID: "msg_queued",
      parts: [{ type: "text", text: "then run the tests" }],
      delivery: "queue",
    }))

    expect(await response.json()).toEqual({ delivery: "queue" })
    for (let attempt = 0; attempt < 200 && abandons.length < 1; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(abandons).toEqual([0])
  })

  test("a queued prompt is persisted while it waits and dropped when its turn starts", async () => {
    const queue = durableQueue()
    const starts: AgentRuntimeTurnStartInput[] = []
    let release!: () => void
    const idle = new Promise<void>((resolve) => { release = resolve })
    const response = await routes(
      runtimeDouble({ starts, deliveries: ["start"], idle: () => idle }),
      queue.host,
    ).request("http://localhost/session/session_1/prompt_async", prompt({
      messageID: "msg_durable",
      parts: [{ type: "text", text: "then run the tests" }],
      agent: "build",
      model: { providerID: "test", modelID: "fixture" },
      delivery: "queue",
    }))

    expect(await response.json()).toEqual({ delivery: "queue" })
    expect(queue.store.listQueuedPrompts()).toEqual([{
      sessionId: "session_1",
      seq: 1,
      messageId: "msg_durable",
      parts: [{ type: "text", text: "then run the tests" }],
      agent: "build",
      model: { providerID: "test", modelID: "fixture" },
      delivery: "queue",
      queuedAt: queue.store.listQueuedPrompts()[0].queuedAt,
      provenance: "loopback-direct",
    }])

    release()
    for (let attempt = 0; attempt < 200 && queue.store.listQueuedPrompts().length > 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(starts).toHaveLength(1)
    expect(queue.store.listQueuedPrompts()).toEqual([])
    expect(queue.recoveries).toEqual([])
  })

  test("an immediately runnable queued prompt is consumed by the durable owner", async () => {
    const queue = durableQueue()
    const starts: AgentRuntimeTurnStartInput[] = []
    await routes(runtimeDouble({ starts, deliveries: ["start"] }), queue.host)
      .request("http://localhost/session/session_1/prompt_async", prompt({
        messageID: "msg_immediate",
        parts: [{ type: "text", text: "start the work" }],
        delivery: "queue",
      }))

    for (let i = 0; i < 100 && queue.store.listQueuedPrompts().length; i++) await new Promise((resolve) => setTimeout(resolve, 2))
    expect(starts).toHaveLength(1)
    expect(queue.store.listQueuedPrompts()).toEqual([])
  })

  test("a prompt that asked nothing about delivery keeps the empty acknowledgement", async () => {
    const starts: AgentRuntimeTurnStartInput[] = []
    const response = await routes(runtimeDouble({ starts, deliveries: [] }))
      .request("http://localhost/session/session_1/prompt_async", prompt({
        messageID: "msg_plain",
        parts: [{ type: "text", text: "start the work" }],
      }))

    expect(response.status).toBe(204)
    expect(await response.text()).toBe("")
    expect(starts.map((turn) => turn.delivery)).toEqual([undefined])
  })
})

describe("queued message controls", () => {
  test("lists multiple prompts, removes only the selected one, and never starts it later", async () => {
    const queue = durableQueue()
    const starts: AgentRuntimeTurnStartInput[] = []
    const abandons: number[] = []
    let release!: () => void
    const idle = new Promise<void>((resolve) => { release = resolve })
    const app = routes(runtimeDouble({ starts, abandons, deliveries: ["start"], idle: () => idle }), queue.host)
    for (const messageID of ["first", "second"]) {
      await app.request("http://localhost/session/session_1/prompt_async", prompt({ messageID, delivery: "queue", parts: [{ type: "text", text: messageID }] }))
    }
    const rows = await (await app.request("http://localhost/session/session_1/queue")).json() as Array<{ seq: number; messageId: string }>
    expect(rows.map((row) => row.messageId)).toEqual(["first", "second"])
    expect((await app.request(`http://localhost/session/session_1/queue/${rows[0].seq}/cancel`, { method: "POST" })).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(queue.host.list("session_1").map((row) => row.messageId)).toEqual(["second"])
    release()
    for (let i = 0; i < 50 && starts.length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 2))
    expect(starts.map((turn) => turn.messageId)).toEqual(["second"])
    expect(queue.host.list("session_1")).toEqual([])
    expect(abandons).toHaveLength(1)
  })

  test("steers a selected queued message immediately and does not replay it on idle", async () => {
    const queue = durableQueue()
    const starts: AgentRuntimeTurnStartInput[] = []
    let release!: () => void
    const idle = new Promise<void>((resolve) => { release = resolve })
    const app = routes(runtimeDouble({ starts, deliveries: ["steer"], idle: () => idle }), queue.host)
    await app.request("http://localhost/session/session_1/prompt_async", prompt({ messageID: "steer-me", delivery: "queue", parts: [{ type: "text", text: "do this now" }] }))
    const seq = queue.host.list("session_1")[0].seq
    expect((await app.request(`http://localhost/session/session_1/queue/${seq}/steer`, { method: "POST" })).status).toBe(200)
    for (let i = 0; i < 50 && starts.length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 2))
    expect(starts.map((turn) => turn.delivery)).toEqual(["steer"])
    expect(queue.host.list("session_1")[0].steering?.state).toBe("accepted")
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(starts).toHaveLength(1)
    expect((await app.request(`http://localhost/session/session_1/queue/${seq}/cancel`, { method: "POST" })).status).toBe(423)
  })

  test("replaces a waiting message's parts in the durable row and in the turn it becomes", async () => {
    const queue = durableQueue()
    const starts: AgentRuntimeTurnStartInput[] = []
    let release!: () => void
    const idle = new Promise<void>((resolve) => { release = resolve })
    const app = routes(runtimeDouble({ starts, deliveries: ["start"], idle: () => idle }), queue.host)
    await app.request("http://localhost/session/session_1/prompt_async", prompt({ messageID: "edit-me", delivery: "queue", parts: [{ type: "text", text: "first draft" }] }))
    const seq = queue.host.list("session_1")[0].seq
    const edited = [{ type: "text" as const, text: "second draft" }]
    expect((await app.request(`http://localhost/session/session_1/queue/${seq}/replace`, prompt({ parts: edited }))).status).toBe(200)
    expect((await app.request(`http://localhost/session/session_1/queue/${seq}/replace`, prompt({ parts: [] }))).status).toBe(400)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(queue.host.list("session_1").map((row) => row.parts)).toEqual([edited])
    expect(starts).toHaveLength(0)
    expect((await app.request(`http://localhost/session/session_1/queue/${seq}/cancel`, { method: "POST" })).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(queue.host.list("session_1")).toEqual([])
    release()
  })

  test("a held message waits past the idle it would have started on, until released", async () => {
    const queue = durableQueue()
    const starts: AgentRuntimeTurnStartInput[] = []
    let release!: () => void
    const idle = new Promise<void>((resolve) => { release = resolve })
    const app = routes(runtimeDouble({ starts, deliveries: ["start"], idle: () => idle }), queue.host)
    await app.request("http://localhost/session/session_1/prompt_async", prompt({ messageID: "hold-me", delivery: "queue", parts: [{ type: "text", text: "being edited" }] }))
    const seq = queue.host.list("session_1")[0].seq
    expect((await app.request(`http://localhost/session/session_1/queue/${seq}/hold`, { method: "POST" })).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await (await app.request("http://localhost/session/session_1/queue")).json() as Array<{ held: boolean }>).map((row) => row.held)).toEqual([true])
    release()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(starts).toHaveLength(0)
    expect(queue.host.list("session_1").map((row) => row.messageId)).toEqual(["hold-me"])
    expect((await app.request(`http://localhost/session/session_1/queue/${seq}/release`, { method: "POST" })).status).toBe(200)
    for (let i = 0; i < 50 && starts.length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 2))
    expect(starts.map((turn) => turn.messageId)).toEqual(["hold-me"])
    expect(queue.host.list("session_1")).toEqual([])
  })

  test("replacing a held message's parts also releases it", async () => {
    const queue = durableQueue()
    const starts: AgentRuntimeTurnStartInput[] = []
    let release!: () => void
    const idle = new Promise<void>((resolve) => { release = resolve })
    const app = routes(runtimeDouble({ starts, deliveries: ["start"], idle: () => idle }), queue.host)
    await app.request("http://localhost/session/session_1/prompt_async", prompt({ messageID: "hold-me", delivery: "queue", parts: [{ type: "text", text: "being edited" }] }))
    const seq = queue.host.list("session_1")[0].seq
    expect((await app.request(`http://localhost/session/session_1/queue/${seq}/hold`, { method: "POST" })).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(starts).toHaveLength(0)
    expect((await app.request(`http://localhost/session/session_1/queue/${seq}/replace`, prompt({ parts: [{ type: "text" as const, text: "edited" }] }))).status).toBe(200)
    for (let i = 0; i < 50 && starts.length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 2))
    expect(starts[0]?.parts).toEqual([{ type: "text", text: "edited" }])
    expect(queue.host.list("session_1")).toEqual([])
  })

  test("a replaced message starts with its edited parts once the session frees up", async () => {
    const queue = durableQueue()
    const starts: AgentRuntimeTurnStartInput[] = []
    let release!: () => void
    const idle = new Promise<void>((resolve) => { release = resolve })
    const app = routes(runtimeDouble({ starts, deliveries: ["start"], idle: () => idle }), queue.host)
    await app.request("http://localhost/session/session_1/prompt_async", prompt({ messageID: "edit-me", delivery: "queue", parts: [{ type: "text", text: "first draft" }] }))
    const seq = queue.host.list("session_1")[0].seq
    expect((await app.request(`http://localhost/session/session_1/queue/${seq}/replace`, prompt({ parts: [{ type: "text", text: "second draft" }] }))).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()
    for (let i = 0; i < 50 && starts.length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 2))
    expect(starts.map((turn) => turn.parts)).toEqual([[{ type: "text", text: "second draft" }]])
    expect(queue.host.list("session_1")).toEqual([])
    expect((await app.request(`http://localhost/session/session_1/queue/${seq}/replace`, prompt({ parts: [{ type: "text", text: "too late" }] }))).status).toBe(409)
  })
})


describe("a relayed prompt queued on a plane that mints deferred grants", () => {
  const QUEUED_GRANT = "eyJ.queued-prompt-grant.sig"

  test("queue and steer each take a grant for the message id fixed at queue time and store it on the row", async () => {
    const queue = durableQueue()
    const rows = persistedRows(queue)
    const starts: AgentRuntimeTurnStartInput[] = []
    let release!: () => void
    const idle = new Promise<void>((resolve) => { release = resolve })
    const { app, granted } = grantingRoutes(runtimeDouble({ starts, deliveries: ["steer", "start"], idle: () => idle }), queue.host, {
      relayed: true,
      grant: (request) => ({ allowed: true, grant: `${QUEUED_GRANT}.${request.turnId}`, expiresAt: Date.now() + 60_000 }),
    })

    const steered = await app.request("http://localhost/session/session_1/message", relayedPrompt({
      messageID: "msg_steer", parts: [{ type: "text", text: "also check the docs" }], delivery: "steer",
    }))
    expect(await steered.json()).toEqual({ delivery: "steer", messageID: "msg_steer" })
    const queued = await app.request("http://localhost/session/session_1/prompt_async", relayedPrompt({
      messageID: "msg_queue", parts: [{ type: "text", text: "then run the tests" }], delivery: "queue",
    }))
    expect(await queued.json()).toEqual({ delivery: "queue" })

    const minted = (turnId: string) => expect.objectContaining({
      operation: "prompt",
      sessionId: "session_1",
      intent: "queued_prompt",
      turnId,
      credential: "Bearer signed-rht",
      actor: RELAYED_ACTOR,
      authority: RELAYED_AUTHORITY,
    })
    expect(granted).toEqual([minted("msg_steer"), minted("msg_queue")])
    expect(granted.every((request) => !("subjectSessionId" in request))).toBe(true)
    expect(rows.map((row) => [row.messageId, row.provenance, row.grant])).toEqual([
      ["msg_steer", "relay-replayed", `${QUEUED_GRANT}.msg_steer`],
      ["msg_queue", "relay-replayed", `${QUEUED_GRANT}.msg_queue`],
    ])
    expect(queue.store.listQueuedPrompts().find((row) => row.messageId === "msg_queue")?.grant).toBe(`${QUEUED_GRANT}.msg_queue`)
    expect(JSON.stringify(await (await app.request("http://localhost/session/session_1/queue")).json())).not.toContain(QUEUED_GRANT)
    release()
    for (let attempt = 0; attempt < 200 && queue.store.listQueuedPrompts().length > 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(starts.map((turn) => turn.messageId)).toEqual(["msg_steer", "msg_queue"])
  })

  test("a refused grant answers 503 on both routes and queues nothing", async () => {
    const queue = durableQueue()
    const starts: AgentRuntimeTurnStartInput[] = []
    const { app, granted } = grantingRoutes(runtimeDouble({ starts, deliveries: ["steer", "start"] }), queue.host, {
      relayed: true,
      grant: () => ({ allowed: false, status: 403, code: "session_private", message: "The session no longer admits this actor's turn" }),
    })

    const steered = await app.request("http://localhost/session/session_1/message", relayedPrompt({
      messageID: "msg_steer", parts: [{ type: "text", text: "also check the docs" }], delivery: "steer",
    }))
    expect(steered.status).toBe(503)
    expect(await steered.json()).toMatchObject({ error: { code: "queued_prompt_grant_refused" } })
    const queued = await app.request("http://localhost/session/session_1/prompt_async", relayedPrompt({
      messageID: "msg_queue", parts: [{ type: "text", text: "then run the tests" }], delivery: "queue",
    }))
    expect(queued.status).toBe(503)
    expect(await queued.json()).toMatchObject({ error: { code: "queued_prompt_grant_refused" } })

    expect(granted.map((request) => request.turnId)).toEqual(["msg_steer", "msg_queue"])
    expect(queue.store.listQueuedPrompts()).toEqual([])
    expect(starts).toEqual([])
  })

  test("the machine's own user over loopback queues without a grant, whatever the plane could mint", async () => {
    const queue = durableQueue()
    const rows = persistedRows(queue)
    const starts: AgentRuntimeTurnStartInput[] = []
    const { app, granted } = grantingRoutes(runtimeDouble({ starts, deliveries: ["start"] }), queue.host, {
      relayed: false,
      grant: () => { throw new Error("a loopback request has no actor to mint for") },
    })

    const queued = await app.request("http://localhost/session/session_1/prompt_async", prompt({
      messageID: "msg_local", parts: [{ type: "text", text: "then run the tests" }], delivery: "queue",
    }))
    expect(queued.status).toBe(200)
    expect(granted).toEqual([])
    expect(rows).toEqual([expect.objectContaining({ messageId: "msg_local", provenance: "loopback-direct" })])
    expect(rows[0]).not.toHaveProperty("grant")
    for (let attempt = 0; attempt < 200 && queue.store.listQueuedPrompts().length > 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(starts.map((turn) => turn.messageId)).toEqual(["msg_local"])
  })
})

test("a queued request never republishes the runtime-owned event stream", async () => {
  const starts: AgentRuntimeTurnStartInput[] = []
  let release!: () => void
  const idle = new Promise<void>((resolve) => { release = resolve })
  const runtime = runtimeDouble({ starts, deliveries: ["start"], idle: () => idle })
  let subscriptions = 0
  runtime.events.subscribe = () => {
    const label = `output subscription ${++subscriptions}`
    return (async function* () {
      yield { sessionId: "session_1", directory: undefined, payload: { type: "text-delta", delta: label } }
      yield { sessionId: "session_1", directory: undefined, payload: sessionIdle("session_1") }
    })() as ReturnType<AgentRuntime["events"]["subscribe"]>
  }
  const published: unknown[] = []
  await routes(runtime, undefined, published).request("http://localhost/session/session_1/prompt_async", prompt({
    messageID: "next", delivery: "queue", parts: [{ type: "text", text: "next" }],
  }))
  release()
  for (let i = 0; i < 50; i++) {
    if (subscriptions >= 1) break
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  expect(subscriptions).toBe(1)
  expect(published).toEqual([])
})

test("synchronous queued submission is a durable acknowledgement, not a request-owned waiter", async () => {
  const queue = durableQueue()
  const starts: AgentRuntimeTurnStartInput[] = []
  let release!: () => void
  const idle = new Promise<void>((resolve) => { release = resolve })
  const app = routes(runtimeDouble({ starts, deliveries: ["start"], idle: () => idle }), queue.host)
  const response = await app.request("http://localhost/session/session_1/message", prompt({
    messageID: "sync-queued", delivery: "queue", parts: [{ type: "text", text: "later" }],
  }))
  expect(response.status).toBe(202)
  expect(await response.json()).toEqual({ delivery: "queue", messageID: "sync-queued" })
  expect(starts).toEqual([])
  expect(queue.store.listQueuedPrompts()[0].messageId).toBe("sync-queued")
  release()
  for (let i = 0; i < 100 && queue.store.listQueuedPrompts().length; i++) await new Promise((resolve) => setTimeout(resolve, 2))
  expect(starts).toHaveLength(1)
  expect(queue.store.listQueuedPrompts()).toEqual([])
})

test("HTTP refuses queue admission when persistence is unavailable", async () => {
  const host = createSessionDeliveryOwner({ store: () => undefined,
    whenIdle: async () => { throw new Error("must not execute") }, startTurn: async () => { throw new Error("must not execute") } })
  const starts: AgentRuntimeTurnStartInput[] = []
  const app = routes(runtimeDouble({ starts, deliveries: ["queue"] }), host)
  const response = await app.request("http://localhost/session/session_1/prompt_async", prompt({ messageID: "not-saved", delivery: "queue", parts: [] }))
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ error: "This runtime cannot persist queued input" })
  await host.dispose()
})
