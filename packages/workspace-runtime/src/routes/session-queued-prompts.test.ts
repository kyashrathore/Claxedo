import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "bun:test"
import type { AgentRuntime, AgentRuntimeTurnStartInput, PromptDelivery } from "@claxedo/agent-sdk-runtime"
import { sessionIdle } from "../compat-events"
import { runRuntimePromptTurn } from "../session/service"
import { RuntimeStore } from "../store"
import { createQueuedPromptHost, type QueuedPromptStore } from "./session-queued-prompts"

const roots: string[] = []
const stores: RuntimeStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function store(root: string) {
  const opened = new RuntimeStore(root)
  stores.push(opened)
  return opened
}

function root() {
  const created = mkdtempSync(join(tmpdir(), "wr-queued-prompt-"))
  roots.push(created)
  return created
}

function port(runtimeStore: RuntimeStore, directory: string | undefined): QueuedPromptStore {
  return {
    queuePrompt: (input) => runtimeStore.queuePrompt(input),
    deleteQueuedPrompt: (sessionId, seq) => runtimeStore.deleteQueuedPrompt(sessionId, seq),
    listQueuedPrompts: () => runtimeStore.listQueuedPrompts(),
    sessionDirectory: () => directory,
  }
}

function runtimeDouble(input: {
  starts: AgentRuntimeTurnStartInput[]
  deliveries: PromptDelivery[]
  idle?: () => Promise<void>
}) {
  return {
    turns: {
      start: async (turn: AgentRuntimeTurnStartInput) => {
        input.starts.push(turn)
        return {
          sessionId: turn.sessionId,
          userMessageId: turn.messageId ?? "user_1",
          assistantMessageId: "assistant_1",
          directory: undefined,
          delivery: input.deliveries.shift() ?? "start",
          prompt: {
            parts: turn.parts ?? [],
            userMessageId: turn.messageId ?? "user_1",
            assistantMessageId: "assistant_1",
            agent: "build",
            model: { providerID: "test", modelID: "fixture" },
          },
        }
      },
      whenIdle: async () => await (input.idle?.() ?? Promise.resolve()),
    },
    events: {
      subscribe: () => (async function* () {
        yield { sessionId: "session_1", directory: undefined, payload: sessionIdle("session_1") }
      })(),
      list: async () => [],
    },
  } as unknown as AgentRuntime
}

/**
 * The recovery driver routes/session.ts supplies: the runtime's own start path,
 * answering as soon as the turn is admitted while the turn itself runs on.
 */
function hostFor(runtimeStore: RuntimeStore, runtime: AgentRuntime, directory: string | undefined) {
  return createQueuedPromptHost({
    store: () => port(runtimeStore, directory),
    startTurn: (input) => new Promise<void>((resolve) => {
      void runRuntimePromptTurn({
        runtime,
        sessionId: input.sessionId,
        directory: input.directory,
        body: input.body,
        publishGlobal: () => {},
        publishStatus: () => {},
        onDelivery: input.onDelivery,
        onAdmissionSettled: () => resolve(),
        ...(input.actor ? { actor: input.actor } : {}),
        ...(input.author ? { author: input.author } : {}),
      }).catch(() => resolve())
    }),
  })
}

function queued(runtimeStore: RuntimeStore, messageId = "msg_survivor") {
  return runtimeStore.queuePrompt({
    sessionId: "session_1",
    messageId,
    parts: [{ type: "text", text: "then run the tests" }],
    agent: "build",
    model: { providerID: "test", modelID: "fixture" },
    permissionMode: "ask",
    delivery: "queue",
    actor: { actorId: "actor_1", actorKind: "human" },
    author: { id: "pub_1", name: "Yash", kind: "human" },
  })
}

test("a prompt queued by a process that died is started by the next runtime", async () => {
  const directory = root()
  const died = store(directory)
  queued(died)
  died.close()

  const restarted = store(directory)
  const starts: AgentRuntimeTurnStartInput[] = []
  await hostFor(restarted, runtimeDouble({ starts, deliveries: ["start"] }), "/workspace").recover()

  expect(starts).toHaveLength(1)
  expect(starts[0]).toMatchObject({
    sessionId: "session_1",
    messageId: "msg_survivor",
    parts: [{ type: "text", text: "then run the tests" }],
    agent: "build",
    model: { providerID: "test", modelID: "fixture" },
    permissionMode: "ask",
    delivery: "queue",
    actorId: "actor_1",
    actorKind: "human",
    author: { id: "pub_1", name: "Yash", kind: "human" },
  })
  expect(restarted.listQueuedPrompts()).toEqual([])
})

test("two prompts one session was holding are re-issued in the order they were queued", async () => {
  const directory = root()
  const died = store(directory)
  queued(died, "msg_first")
  queued(died, "msg_second")
  died.close()

  const restarted = store(directory)
  const starts: AgentRuntimeTurnStartInput[] = []
  await hostFor(
    restarted,
    runtimeDouble({ starts, deliveries: ["start", "queue"], idle: () => new Promise<void>(() => {}) }),
    "/workspace",
  ).recover()

  expect(starts.map((turn) => turn.messageId)).toEqual(["msg_first", "msg_second"])
  expect(restarted.listQueuedPrompts().map((row) => [row.seq, row.messageId])).toEqual([[2, "msg_second"]])
})

test("a recovered prompt the runtime queues again stays durable until it starts", async () => {
  const runtimeStore = store(root())
  queued(runtimeStore)
  const starts: AgentRuntimeTurnStartInput[] = []
  let release!: () => void
  const idle = new Promise<void>((resolve) => { release = resolve })
  const recovering = hostFor(
    runtimeStore,
    runtimeDouble({ starts, deliveries: ["queue", "start"], idle: () => idle }),
    "/workspace",
  ).recover()

  await recovering
  expect(starts).toHaveLength(1)
  expect(runtimeStore.listQueuedPrompts().map((row) => row.messageId)).toEqual(["msg_survivor"])

  release()
  await until(() => runtimeStore.listQueuedPrompts().length === 0)
  expect(starts).toHaveLength(2)
})

test("a prompt whose session is gone is dropped instead of retried by every boot", async () => {
  const runtimeStore = store(root())
  queued(runtimeStore)
  const starts: AgentRuntimeTurnStartInput[] = []
  await hostFor(runtimeStore, runtimeDouble({ starts, deliveries: [] }), undefined).recover()

  expect(starts).toEqual([])
  expect(runtimeStore.listQueuedPrompts()).toEqual([])
})

test("a prompt the runtime never took is dropped rather than retried by every boot", async () => {
  const runtimeStore = store(root())
  queued(runtimeStore)
  const attempts: string[] = []
  await createQueuedPromptHost({
    store: () => port(runtimeStore, "/workspace"),
    // A turn that failed before the runtime decided anything: no delivery.
    startTurn: async (input) => {
      attempts.push(input.sessionId)
    },
  }).recover()

  expect(attempts).toEqual(["session_1"])
  expect(runtimeStore.listQueuedPrompts()).toEqual([])
})

test("recovery re-issues each prompt once, however many requests ask for it", async () => {
  const runtimeStore = store(root())
  queued(runtimeStore)
  const starts: AgentRuntimeTurnStartInput[] = []
  const host = hostFor(runtimeStore, runtimeDouble({ starts, deliveries: ["start", "start"] }), "/workspace")

  await Promise.all([host.recover(), host.recover()])
  await host.recover()

  expect(starts).toHaveLength(1)
})

test("a pass the runtime could not take a prompt for does not count as recovery", async () => {
  const runtimeStore = store(root())
  queued(runtimeStore)
  const attempts: string[] = []
  let harness = false
  const host = createQueuedPromptHost({
    store: () => port(runtimeStore, "/workspace"),
    startTurn: async (input) => {
      attempts.push(input.sessionId)
      if (!harness) throw new Error("the runtime has no harness yet")
      input.onDelivery("start")
    },
  })

  await host.recover()

  expect(attempts).toEqual(["session_1"])
  expect(runtimeStore.listQueuedPrompts()).toHaveLength(1)

  harness = true
  await host.recover()

  expect(attempts).toEqual(["session_1", "session_1"])
  expect(runtimeStore.listQueuedPrompts()).toEqual([])
})

test("a store that cannot persist queued prompts leaves the queue in the request", async () => {
  const starts: string[] = []
  const host = createQueuedPromptHost({
    store: () => undefined,
    startTurn: async (input) => {
      starts.push(input.sessionId)
    },
  })

  host.queue({ sessionId: "session_1", body: { parts: [{ type: "text", text: "then run the tests" }] } }).release()
  await host.recover()

  expect(starts).toEqual([])
})

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  if (!condition()) throw new Error("condition never held")
}
