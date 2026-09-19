import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { createSessionRoutes } from "./session-core"
import { createQueuedPromptHost, type QueuedPromptHost } from "./session-queued-prompts"
import type { AgentRuntime, AgentRuntimeTurnStartInput, PromptDelivery } from "@claxedo/agent-sdk-runtime"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import { sessionIdle } from "../compat-events"
import { RuntimeStore } from "../store"

const roots: string[] = []
const stores: RuntimeStore[] = []

afterEach(() => {
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
    abort: async () => ({ ok: true, status: "cancelled" }),
    dispose: () => {},
  }
}

function runtimeDouble(input: {
  starts: AgentRuntimeTurnStartInput[]
  deliveries: PromptDelivery[]
  aborts?: Array<{ turnId?: string } | undefined>
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
          prompt: {
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
      abort: async (_sessionId: string, _directory: unknown, scope?: { turnId?: string }) => {
        input.aborts?.push(scope)
        return { ok: true, status: "cancelled" }
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

function routes(runtime: AgentRuntime, queuedPrompts?: QueuedPromptHost, published: unknown[] = []) {
  return createSessionRoutes({
    resolveAdapter: () => adapter(),
    resolveRuntime: () => runtime,
    resolveDirectory: () => undefined,
    publishGlobal: (event) => { published.push(event) },
    ...(queuedPrompts ? { queuedPrompts } : {}),
  })
}

/** The durable queue the host lends the routes, on a real store. */
function durableQueue() {
  const store = new RuntimeStore(storeRoot())
  stores.push(store)
  const recoveries: string[] = []
  return {
    store,
    recoveries,
    host: createQueuedPromptHost({
      store: () => ({
        queuePrompt: (input) => store.queuePrompt(input),
        deleteQueuedPrompt: (sessionId: string, seq: number) => store.deleteQueuedPrompt(sessionId, seq),
        replaceQueuedPromptParts: (sessionId: string, seq: number, parts) => store.replaceQueuedPromptParts(sessionId, seq, parts),
        listQueuedPrompts: () => store.listQueuedPrompts(),
        sessionDirectory: () => "/workspace",
      }),
      startTurn: async (input) => {
        recoveries.push(input.sessionId)
      },
    }),
  }
}

function prompt(body: Record<string, unknown>) {
  return { method: "POST", body: JSON.stringify(body) }
}

describe("how a prompt for a busy session is delivered", () => {
  test("a prompt asking to steer carries that to the runtime and answers with what happened", async () => {
    const starts: AgentRuntimeTurnStartInput[] = []
    const response = await routes(runtimeDouble({ starts, deliveries: ["steer"] }))
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
      deliveries: ["queue", "start"],
      idle: () => idle,
    })).request("http://localhost/session/session_1/prompt_async", prompt({
      messageID: "msg_queued",
      parts: [{ type: "text", text: "then run the tests" }],
      delivery: "queue",
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ delivery: "queue" })
    expect(starts).toHaveLength(1)
    release()
    for (let attempt = 0; attempt < 200 && starts.length < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(starts.map((turn) => turn.messageId)).toEqual(["msg_queued", "msg_queued"])
  })

  test("a queued prompt whose start fails gives the session up for the next waiter", async () => {
    const starts: AgentRuntimeTurnStartInput[] = []
    const abandons: number[] = []
    const runtime = runtimeDouble({
      starts,
      deliveries: ["queue"],
      refuse: (attempt) => attempt === 2 ? new Error("the runtime has no adapter for this session") : undefined,
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
    expect(abandons).toEqual([1])
  })

  test("a queued prompt is persisted while it waits and dropped when its turn starts", async () => {
    const queue = durableQueue()
    const starts: AgentRuntimeTurnStartInput[] = []
    let release!: () => void
    const idle = new Promise<void>((resolve) => { release = resolve })
    const response = await routes(
      runtimeDouble({ starts, deliveries: ["queue", "start"], idle: () => idle }),
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
    }])

    release()
    for (let attempt = 0; attempt < 200 && queue.store.listQueuedPrompts().length > 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(starts).toHaveLength(2)
    expect(queue.store.listQueuedPrompts()).toEqual([])
    expect(queue.recoveries).toEqual([])
  })

  test("a prompt that starts straight away is never persisted", async () => {
    const queue = durableQueue()
    const starts: AgentRuntimeTurnStartInput[] = []
    await routes(runtimeDouble({ starts, deliveries: ["start"] }), queue.host)
      .request("http://localhost/session/session_1/prompt_async", prompt({
        messageID: "msg_immediate",
        parts: [{ type: "text", text: "start the work" }],
        delivery: "queue",
      }))

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

describe("scoping Stop to a turn", () => {
  test("the turn the caller names reaches the runtime's abort", async () => {
    const aborts: Array<{ turnId?: string } | undefined> = []
    const response = await routes(runtimeDouble({ starts: [], deliveries: [], aborts }))
      .request("http://localhost/session/session_1/abort?turnId=msg_first", { method: "POST" })

    expect(response.status).toBe(200)
    expect(aborts).toEqual([{ turnId: "msg_first" }])
  })

  test("a Stop with no turn named still aborts whatever is running", async () => {
    const aborts: Array<{ turnId?: string } | undefined> = []
    const response = await routes(runtimeDouble({ starts: [], deliveries: [], aborts }))
      .request("http://localhost/session/session_1/abort", { method: "POST" })

    expect(response.status).toBe(200)
    expect(aborts).toHaveLength(1)
    expect(aborts[0]).toBeUndefined()
  })
})

describe("queued message controls", () => {
  test("lists multiple prompts, removes only the selected one, and never starts it later", async () => {
    const queue = durableQueue()
    const starts: AgentRuntimeTurnStartInput[] = []
    const abandons: number[] = []
    let release!: () => void
    const idle = new Promise<void>((resolve) => { release = resolve })
    const app = routes(runtimeDouble({ starts, abandons, deliveries: ["queue", "queue", "start"], idle: () => idle }), queue.host)
    for (const messageID of ["first", "second"]) {
      await app.request("http://localhost/session/session_1/prompt_async", prompt({ messageID, delivery: "queue", parts: [{ type: "text", text: messageID }] }))
    }
    const rows = await (await app.request("http://localhost/session/session_1/queue")).json() as Array<{ seq: number; messageId: string }>
    expect(rows.map((row) => row.messageId)).toEqual(["first", "second"])
    expect((await app.request(`http://localhost/session/session_1/queue/${rows[0].seq}/cancel`, { method: "POST" })).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(queue.host.list("session_1").map((row) => row.messageId)).toEqual(["second"])
    release()
    for (let i = 0; i < 50 && starts.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 2))
    expect(starts.map((turn) => turn.messageId)).toEqual(["first", "second", "second"])
    expect(queue.host.list("session_1")).toEqual([])
    expect(abandons).toHaveLength(1)
  })

  test("steers a selected queued message immediately and does not replay it on idle", async () => {
    const queue = durableQueue()
    const starts: AgentRuntimeTurnStartInput[] = []
    let release!: () => void
    const idle = new Promise<void>((resolve) => { release = resolve })
    const app = routes(runtimeDouble({ starts, deliveries: ["queue", "steer"], idle: () => idle }), queue.host)
    await app.request("http://localhost/session/session_1/prompt_async", prompt({ messageID: "steer-me", delivery: "queue", parts: [{ type: "text", text: "do this now" }] }))
    const seq = queue.host.list("session_1")[0].seq
    expect((await app.request(`http://localhost/session/session_1/queue/${seq}/steer`, { method: "POST" })).status).toBe(200)
    for (let i = 0; i < 50 && starts.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 2))
    expect(starts.map((turn) => turn.delivery)).toEqual(["queue", "steer"])
    expect(queue.host.list("session_1")).toEqual([])
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(starts).toHaveLength(2)
    expect((await app.request(`http://localhost/session/session_1/queue/${seq}/cancel`, { method: "POST" })).status).toBe(409)
  })

  test("replaces a waiting message's parts in the durable row and in the turn it becomes", async () => {
    const queue = durableQueue()
    const starts: AgentRuntimeTurnStartInput[] = []
    let release!: () => void
    const idle = new Promise<void>((resolve) => { release = resolve })
    const app = routes(runtimeDouble({ starts, deliveries: ["queue", "start"], idle: () => idle }), queue.host)
    await app.request("http://localhost/session/session_1/prompt_async", prompt({ messageID: "edit-me", delivery: "queue", parts: [{ type: "text", text: "first draft" }] }))
    const seq = queue.host.list("session_1")[0].seq
    const edited = [{ type: "text" as const, text: "second draft" }]
    expect((await app.request(`http://localhost/session/session_1/queue/${seq}/replace`, prompt({ parts: edited }))).status).toBe(200)
    expect((await app.request(`http://localhost/session/session_1/queue/${seq}/replace`, prompt({ parts: [] }))).status).toBe(400)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(queue.host.list("session_1").map((row) => row.parts)).toEqual([edited])
    expect(starts).toHaveLength(1)
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
    const app = routes(runtimeDouble({ starts, deliveries: ["queue", "start"], idle: () => idle }), queue.host)
    await app.request("http://localhost/session/session_1/prompt_async", prompt({ messageID: "hold-me", delivery: "queue", parts: [{ type: "text", text: "being edited" }] }))
    const seq = queue.host.list("session_1")[0].seq
    expect((await app.request(`http://localhost/session/session_1/queue/${seq}/hold`, { method: "POST" })).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await (await app.request("http://localhost/session/session_1/queue")).json() as Array<{ held: boolean }>).map((row) => row.held)).toEqual([true])
    release()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(starts).toHaveLength(1)
    expect(queue.host.list("session_1").map((row) => row.messageId)).toEqual(["hold-me"])
    expect((await app.request(`http://localhost/session/session_1/queue/${seq}/release`, { method: "POST" })).status).toBe(200)
    for (let i = 0; i < 50 && starts.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 2))
    expect(starts.map((turn) => turn.messageId)).toEqual(["hold-me", "hold-me"])
    expect(queue.host.list("session_1")).toEqual([])
  })

  test("replacing a held message's parts also releases it", async () => {
    const queue = durableQueue()
    const starts: AgentRuntimeTurnStartInput[] = []
    let release!: () => void
    const idle = new Promise<void>((resolve) => { release = resolve })
    const app = routes(runtimeDouble({ starts, deliveries: ["queue", "start"], idle: () => idle }), queue.host)
    await app.request("http://localhost/session/session_1/prompt_async", prompt({ messageID: "hold-me", delivery: "queue", parts: [{ type: "text", text: "being edited" }] }))
    const seq = queue.host.list("session_1")[0].seq
    expect((await app.request(`http://localhost/session/session_1/queue/${seq}/hold`, { method: "POST" })).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(starts).toHaveLength(1)
    expect((await app.request(`http://localhost/session/session_1/queue/${seq}/replace`, prompt({ parts: [{ type: "text" as const, text: "edited" }] }))).status).toBe(200)
    for (let i = 0; i < 50 && starts.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 2))
    expect(starts[1]?.parts).toEqual([{ type: "text", text: "edited" }])
    expect(queue.host.list("session_1")).toEqual([])
  })

  test("a replaced message starts with its edited parts once the session frees up", async () => {
    const queue = durableQueue()
    const starts: AgentRuntimeTurnStartInput[] = []
    let release!: () => void
    const idle = new Promise<void>((resolve) => { release = resolve })
    const app = routes(runtimeDouble({ starts, deliveries: ["queue", "start"], idle: () => idle }), queue.host)
    await app.request("http://localhost/session/session_1/prompt_async", prompt({ messageID: "edit-me", delivery: "queue", parts: [{ type: "text", text: "first draft" }] }))
    const seq = queue.host.list("session_1")[0].seq
    expect((await app.request(`http://localhost/session/session_1/queue/${seq}/replace`, prompt({ parts: [{ type: "text", text: "second draft" }] }))).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()
    for (let i = 0; i < 50 && starts.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 2))
    expect(starts.map((turn) => turn.parts)).toEqual([[{ type: "text", text: "first draft" }], [{ type: "text", text: "second draft" }]])
    expect(queue.host.list("session_1")).toEqual([])
    expect((await app.request(`http://localhost/session/session_1/queue/${seq}/replace`, prompt({ parts: [{ type: "text", text: "too late" }] }))).status).toBe(409)
  })
})


test("a queued turn does not replay events buffered from the preceding turn", async () => {
  const starts: AgentRuntimeTurnStartInput[] = []
  let release!: () => void
  const idle = new Promise<void>((resolve) => { release = resolve })
  const runtime = runtimeDouble({ starts, deliveries: ["queue", "start"], idle: () => idle })
  let subscriptions = 0
  runtime.events.subscribe = () => {
    const label = ++subscriptions === 1 ? "old buffered output" : "new output"
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
  for (let i = 0; i < 50 && published.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2))
  expect(subscriptions).toBe(2)
  expect(JSON.stringify(published)).not.toContain("old buffered output")
  expect(JSON.stringify(published)).toContain("new output")
})
