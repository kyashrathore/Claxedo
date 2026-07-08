import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { describe, expect, test } from "bun:test"
import { createAgentRuntime } from "./runtime"
import type { AgentHarnessFactory, AgentRuntimeAbortResult } from "./runtime"
import type { AgentHarnessAdapter } from "./adapter-contract"
import { claude, pi } from "./harnesses"
import { createMemoryRuntimeStore } from "./stores/memory"
import { createSqliteRuntimeStore } from "./stores/sqlite"
import { createConvexRuntimeStore } from "./stores/convex"
import { buildAssistantMessage, buildSession, messagePartUpdated, messageUpdated, permissionAsked, questionAsked, sessionError, sessionIdle, sessionUpdated } from "./compat-events"
import type { AgentRuntimeStreamEvent } from "./index"

async function collectUntilFinish<T extends { payload: { type: string } }>(events: AsyncIterable<T>) {
  const out: T[] = []
  for await (const event of events) {
    out.push(event)
    if (event.payload.type === "finish" || event.payload.type === "session.error") return out
  }
  return out
}

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "agent-runtime-"))
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function testHarness(options: {
  sendMessage?: (id: string) => AsyncIterable<AgentRuntimeStreamEvent>
  abort?: (id: string) => Promise<AgentRuntimeAbortResult>
} = {}): AgentHarnessFactory {
  const adapter: AgentHarnessAdapter = {
    async listSessions() {
      return []
    },
    async getSession() {
      return null
    },
    async createSession() {
      return { id: "ses_test" }
    },
    async updateSession() {
      return null
    },
    async getSessionConfig() {
      return { harness: { id: "pi", access: "native" } }
    },
    async updateSessionConfig(_id, update) {
      return {
        harness: update.harness ?? { id: "pi", access: "native" },
        ...(update.model ? { model: update.model } : {}),
        variant: update.variant ?? null,
        agent: update.agent ?? null,
      }
    },
    async deleteSession() {},
    readHarnessCapabilities() {
      return {} as never
    },
    sendMessage: options.sendMessage ?? (async function* () {}),
    async getMessages() {
      return []
    },
    dispose() {},
    ...(options.abort ? { abort: options.abort } : {}),
  }
  return {
    id: "pi",
    access: "native",
    create: () => adapter,
  } as unknown as AgentHarnessFactory
}

describe("createAgentRuntime", () => {
  test("creates a session, starts a turn, and publishes events", async () => {
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [pi()],
    })
    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
      model: { providerID: "pi", modelID: "virtual" },
      title: "Facade",
    })
    const events = collectUntilFinish(runtime.events.subscribe({ sessionId: session.id }))

    await runtime.turns.start({
      sessionId: session.id,
      messageId: "msg_1",
      text: "exec: printf hello",
    })

    expect((await events).map((event) => event.payload.type)).toContain("finish")
    await tick()
    await expect(runtime.sessions.get(session.id)).resolves.toMatchObject({
      status: null,
      lastTurn: { status: "completed", assistantMessageId: "msg_1_r" },
    })
    await expect(runtime.events.list(session.id)).resolves.toMatchObject([
      { info: { role: "user" } },
      { info: { role: "assistant" } },
    ])
    runtime.dispose()
  })

  test("commits streamed compatibility events to replay before publishing", async () => {
    const store = createMemoryRuntimeStore()
    const runtime = createAgentRuntime({
      store,
      harnesses: [testHarness({
        sendMessage: async function* (id) {
          yield messagePartUpdated({
            id: "part_1",
            sessionID: id,
            messageID: "msg_1_r",
            type: "text",
            text: "streamed reply",
          })
          yield { type: "finish", sessionId: id }
        },
      })],
    })
    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
    })
    const events = collectUntilFinish(runtime.events.subscribe({ sessionId: session.id }))

    await runtime.turns.start({ sessionId: session.id, messageId: "msg_1", text: "hello" })
    await events
    await tick()

    expect(store.getMessages(session.id)).toMatchObject([
      { info: { id: "msg_1", role: "user" } },
      {
        info: { id: "msg_1_r", role: "assistant" },
        parts: [{ id: "part_1", text: "streamed reply" }],
      },
    ])
    runtime.dispose()
  })

  test("aliases emitted assistant ids back to the submitted assistant id", async () => {
    const store = createMemoryRuntimeStore()
    const runtime = createAgentRuntime({
      store,
      harnesses: [testHarness({
        sendMessage: async function* (id) {
          yield messageUpdated(buildAssistantMessage({
            id: "actual-assistant",
            sessionID: id,
            parentID: "msg_1",
            agent: "build",
            model: { providerID: "pi", modelID: "virtual" },
            directory: "",
          }))
          yield messagePartUpdated({
            id: "part_1",
            sessionID: id,
            messageID: "actual-assistant",
            type: "text",
            text: "aliased reply",
          })
          yield { type: "finish", sessionId: id }
        },
      })],
    })
    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
    })
    const events = collectUntilFinish(runtime.events.subscribe({ sessionId: session.id }))

    await runtime.turns.start({ sessionId: session.id, messageId: "msg_1", text: "hello" })
    await events
    await tick()

    expect(store.getMessages(session.id)).toMatchObject([
      { info: { id: "msg_1", role: "user" } },
      {
        info: { id: "msg_1_r", role: "assistant" },
        parts: [{ id: "part_1", text: "aliased reply" }],
      },
    ])
    expect(store.getMessages(session.id)).toHaveLength(2)
    runtime.dispose()
  })

  test("aliases assistant parts even when they arrive before assistant metadata", async () => {
    const store = createMemoryRuntimeStore()
    const runtime = createAgentRuntime({
      store,
      harnesses: [testHarness({
        sendMessage: async function* (id) {
          yield messagePartUpdated({
            id: "part_1",
            sessionID: id,
            messageID: "actual-assistant",
            type: "text",
            text: "part-first reply",
          })
          yield { type: "finish", sessionId: id }
        },
      })],
    })
    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
    })
    const events = collectUntilFinish(runtime.events.subscribe({ sessionId: session.id }))

    await runtime.turns.start({ sessionId: session.id, messageId: "msg_1", text: "hello" })
    await events
    await tick()

    expect(store.getMessages(session.id)).toMatchObject([
      { info: { id: "msg_1", role: "user" } },
      {
        info: { id: "msg_1_r", role: "assistant" },
        parts: [{ id: "part_1", text: "part-first reply" }],
      },
    ])
    expect(store.getMessages(session.id)).toHaveLength(2)
    runtime.dispose()
  })

  test("projects runtime-native text chunks into durable replay", async () => {
    const store = createMemoryRuntimeStore()
    const runtime = createAgentRuntime({
      store,
      harnesses: [testHarness({
        sendMessage: async function* (id) {
          yield { type: "text-delta", delta: "projected reply" }
          yield { type: "finish", sessionId: id }
        },
      })],
    })
    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
    })
    const events = collectUntilFinish(runtime.events.subscribe({ sessionId: session.id }))

    await runtime.turns.start({ sessionId: session.id, messageId: "msg_1", text: "hello" })
    await events
    await tick()

    expect(store.getMessages(session.id)).toMatchObject([
      { info: { id: "msg_1", role: "user" } },
      {
        info: { id: "msg_1_r", role: "assistant" },
        parts: [{ type: "text", text: "projected reply" }],
      },
    ])
    runtime.dispose()
  })

  test("event subscriptions close immediately when returned while idle", async () => {
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [pi()],
    })
    const iterator = runtime.events.subscribe({ sessionId: "idle" })[Symbol.asyncIterator]()

    await expect(iterator.return?.()).resolves.toMatchObject({ done: true })
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    runtime.dispose()
  })

  test("rejects turn starts before returning when the session is unknown", async () => {
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [pi(), claude({ access: "native" })],
    })

    await expect(runtime.turns.start({
      sessionId: "missing",
      text: "hello",
    })).rejects.toThrow("Session missing not found")
    runtime.dispose()
  })

  test("lists sessions created without a directory", async () => {
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [pi()],
    })

    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
      title: "Central",
    })

    await expect(runtime.sessions.list(undefined)).resolves.toMatchObject([{ id: session.id, title: "Central" }])
    await expect(runtime.sessions.get(session.id)).resolves.toMatchObject({ status: null })
    expect((await runtime.sessions.get(session.id))?.lastTurn).toBeUndefined()
    runtime.dispose()
  })

  test("records compat idle as a completed turn outcome", async () => {
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [testHarness({
        sendMessage: async function* (id) {
          yield sessionIdle(id)
        },
      })],
    })
    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
    })

    await runtime.turns.start({ sessionId: session.id, messageId: "msg_1", text: "hello" })
    await tick()

    await expect(runtime.sessions.get(session.id)).resolves.toMatchObject({
      status: null,
      lastTurn: { status: "completed", assistantMessageId: "msg_1_r" },
    })
    runtime.dispose()
  })

  test("auto-titles placeholder sessions on first idle", async () => {
    const store = createMemoryRuntimeStore()
    const runtime = createAgentRuntime({
      store,
      harnesses: [testHarness({
        sendMessage: async function* (id) {
          yield sessionIdle(id)
        },
      })],
    })
    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
      title: "New session - 2026-07-08T09:09:30.378Z",
    })

    await runtime.turns.start({ sessionId: session.id, messageId: "msg_1", text: "Please fix the terminal pane" })
    await tick()

    await expect(runtime.sessions.get(session.id)).resolves.toMatchObject({
      title: "fix the terminal pane",
      lastTurn: { status: "completed", assistantMessageId: "msg_1_r" },
    })
    runtime.dispose()
  })

  test("records compat errors as failed turn outcomes", async () => {
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [testHarness({
        sendMessage: async function* (id) {
          yield sessionError("protocol down", id)
          yield { type: "finish", sessionId: id }
        },
      })],
    })
    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
    })
    const events = collectUntilFinish(runtime.events.subscribe({ sessionId: session.id }))

    await runtime.turns.start({ sessionId: session.id, messageId: "msg_1", text: "hello" })
    await events
    await tick()

    await expect(runtime.sessions.get(session.id)).resolves.toMatchObject({
      status: "error",
      lastTurn: { status: "failed", error: "protocol down", assistantMessageId: "msg_1_r" },
    })
    runtime.dispose()
  })

  test("records thrown adapter errors as failed turn outcomes", async () => {
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [testHarness({
        sendMessage: async function* () {
          throw new Error("adapter exploded")
        },
      })],
    })
    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
    })
    const events = collectUntilFinish(runtime.events.subscribe({ sessionId: session.id }))

    await runtime.turns.start({ sessionId: session.id, messageId: "msg_1", text: "hello" })
    expect((await events).map((event) => event.payload.type)).toContain("session.error")
    await tick()

    await expect(runtime.sessions.get(session.id)).resolves.toMatchObject({
      status: "error",
      lastTurn: { status: "failed", error: "adapter exploded", assistantMessageId: "msg_1_r" },
    })
    runtime.dispose()
  })

  test("keeps a cancelled outcome when a late stream completion arrives", async () => {
    let release: (() => void) | undefined
    const streamDone = new Promise<void>((resolve) => {
      release = resolve
    })
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [testHarness({
        sendMessage: async function* (id) {
          await streamDone
          yield { type: "finish", sessionId: id }
        },
        abort: async () => ({ ok: true, status: "cancelled" }),
      })],
    })
    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
    })

    await runtime.turns.start({ sessionId: session.id, messageId: "msg_1", text: "hello" })
    await expect(runtime.turns.abort(session.id)).resolves.toMatchObject({ ok: true, status: "cancelled" })
    release?.()
    await tick()

    await expect(runtime.sessions.get(session.id)).resolves.toMatchObject({
      status: null,
      lastTurn: { status: "cancelled", reason: "abort", assistantMessageId: "msg_1_r" },
    })
    runtime.dispose()
  })

  test("removes pending interactions when deleting a session", () => {
    const store = createMemoryRuntimeStore()
    store.bindSession({
      sessionId: "ses_1",
      directory: "/repo",
      agentSessionId: "ses_1",
    })
    store.appendEvent({
      sessionId: "ses_1",
      payload: permissionAsked({
        id: "perm_1",
        sessionID: "ses_1",
        tool: "bash",
        metadata: {},
      }),
    })
    store.appendEvent({
      sessionId: "ses_1",
      payload: questionAsked({
        id: "question_1",
        sessionID: "ses_1",
        questions: [{ id: "q1", type: "input", text: "Name?" }],
      }),
    })

    expect(store.listPermissions("/repo")).toHaveLength(1)
    expect(store.listQuestions("/repo")).toHaveLength(1)

    store.deleteSession("ses_1")

    expect(store.listPermissions("/repo")).toEqual([])
    expect(store.listQuestions("/repo")).toEqual([])
  })

  test("preserves message parts across later message metadata updates", async () => {
    const store = createMemoryRuntimeStore()
    store.bindSession({
      sessionId: "ses_1",
      directory: "/repo",
      agentSessionId: "ses_1",
    })
    const info = buildAssistantMessage({
      id: "msg_1",
      sessionID: "ses_1",
      parentID: "user_1",
      agent: "build",
      model: { providerID: "pi", modelID: "virtual" },
      directory: "/repo",
    })

    store.appendEvent({ sessionId: "ses_1", payload: messageUpdated(info) })
    store.appendEvent({
      sessionId: "ses_1",
      payload: messagePartUpdated({
        id: "part_1",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "text",
        text: "hello",
      }),
    })
    store.appendEvent({
      sessionId: "ses_1",
      payload: messageUpdated({ ...info, time: { ...info.time, completed: Date.now() } }),
    })

    expect(store.getMessages("ses_1")).toMatchObject([
      {
        info: { id: "msg_1" },
        parts: [{ id: "part_1", text: "hello" }],
      },
    ])
  })

  test("persists session.updated into the store projection", () => {
    const store = createMemoryRuntimeStore()
    store.bindSession({
      sessionId: "ses_1",
      directory: "/repo",
      title: "Old",
      agentSessionId: "ses_1",
    })

    store.appendEvent({
      sessionId: "ses_1",
      payload: sessionUpdated(buildSession({
        id: "ses_1",
        directory: "/repo",
        title: "Generated title",
      })),
    })

    expect(store.getSession("ses_1")).toMatchObject({ title: "Generated title" })
  })

  test("persists sessions with the sqlite store subpath", async () => {
    const root = tempRoot()
    try {
      const first = createAgentRuntime({
        store: createSqliteRuntimeStore({ root }),
        harnesses: [pi()],
      })
      const session = await first.sessions.create({
        directory: undefined,
        harness: { id: "pi", access: "native" },
        title: "Durable",
      })
      const events = collectUntilFinish(first.events.subscribe({ sessionId: session.id }))
      await first.turns.start({ sessionId: session.id, messageId: "msg_1", text: "exec: printf durable" })
      await events
      await tick()
      first.dispose()

      const second = createAgentRuntime({
        store: createSqliteRuntimeStore({ root }),
        harnesses: [pi()],
      })
      await expect(second.sessions.get(session.id)).resolves.toMatchObject({ id: session.id, title: "Durable" })
      await expect(second.sessions.list(undefined)).resolves.toMatchObject([{
        id: session.id,
        title: "Durable",
        status: null,
        lastTurn: { status: "completed", assistantMessageId: "msg_1_r" },
      }])
      second.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("persists failed turn outcomes with the sqlite store subpath", async () => {
    const root = tempRoot()
    try {
      const first = createAgentRuntime({
        store: createSqliteRuntimeStore({ root }),
        harnesses: [testHarness({
          sendMessage: async function* () {
            throw new Error("sqlite failure")
          },
        })],
      })
      const session = await first.sessions.create({
        directory: undefined,
        harness: { id: "pi", access: "native" },
        title: "Failed durable",
      })
      const events = collectUntilFinish(first.events.subscribe({ sessionId: session.id }))
      await first.turns.start({ sessionId: session.id, messageId: "msg_1", text: "fail" })
      await events
      await tick()
      first.dispose()

      const second = createAgentRuntime({
        store: createSqliteRuntimeStore({ root }),
        harnesses: [testHarness()],
      })
      await expect(second.sessions.get(session.id)).resolves.toMatchObject({
        id: session.id,
        title: "Failed durable",
        status: "error",
        lastTurn: { status: "failed", error: "sqlite failure", assistantMessageId: "msg_1_r" },
      })
      second.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("keeps convex isolated behind its subpath", () => {
    expect(() => createConvexRuntimeStore()).toThrow("requires a Convex client, authority, or projection callbacks")
    expect(() => createConvexRuntimeStore({ client: {} })).toThrow("client-backed persistence is not implemented")
    expect(createConvexRuntimeStore({ projection: {} })).toBeTruthy()
  })

  test("surfaces convex projection failures from flush", async () => {
    const store = createConvexRuntimeStore({
      projection: {
        syncSession: async () => {
          throw new Error("projection down")
        },
      },
    })

    store.bindSession({
      sessionId: "ses_1",
      directory: "/repo",
      agentSessionId: "ses_1",
    })

    await expect(store.flush()).rejects.toThrow("projection down")
  })

  test("syncs sessions and messages through a hosted Convex authority", async () => {
    const calls: Array<{ method: string; args: unknown }> = []
    const store = createConvexRuntimeStore({
      auth: { token: "signed" },
      workspaceId: "ws_1",
      authority: {
        openWorkspace: async (_auth, args) => calls.push({ method: "openWorkspace", args }),
        upsertSessionVisibility: async (_auth, args) => calls.push({ method: "upsertSessionVisibility", args }),
        syncSessionMessages: async (_auth, args) => calls.push({ method: "syncSessionMessages", args }),
      },
    })

    store.bindSession({
      sessionId: "ses_1",
      directory: "/repo",
      title: "Review",
      agentSessionId: "ses_1",
    })
    store.startTurn({
      sessionId: "ses_1",
      userMessageId: "msg_user",
      assistantMessageId: "msg_assistant",
      agent: "build",
      model: { providerID: "pi", modelID: "virtual" },
      parts: [{ type: "text", text: "hello" }],
    })
    store.appendEvent({
      sessionId: "ses_1",
      payload: messagePartUpdated({
        id: "part_1",
        sessionID: "ses_1",
        messageID: "msg_assistant",
        type: "text",
        text: "done",
      }),
    })
    await store.flush()

    expect(calls.map((call) => call.method)).toEqual([
      "openWorkspace",
      "upsertSessionVisibility",
      "openWorkspace",
      "upsertSessionVisibility",
      "openWorkspace",
      "syncSessionMessages",
      "openWorkspace",
      "syncSessionMessages",
    ])
    expect(calls[1]?.args).toMatchObject({
      workspaceId: "ws_1",
      sessions: [{ sessionId: "ses_1", title: "Review" }],
    })
    expect(calls.at(-1)?.args).toMatchObject({
      workspaceId: "ws_1",
      sessionId: "ses_1",
      messages: [
        { info: { id: "msg_user", role: "user" }, parts: [] },
        { info: { id: "msg_assistant", role: "assistant" }, parts: [{ text: "done" }] },
      ],
    })
  })

  test("syncs turn outcomes through convex session projection", async () => {
    const sessions: unknown[] = []
    const store = createConvexRuntimeStore({
      projection: {
        syncSession: (session) => sessions.push(session),
      },
    })

    store.bindSession({
      sessionId: "ses_1",
      directory: "/repo",
      title: "Review",
      agentSessionId: "ses_1",
    })
    store.startTurn({
      sessionId: "ses_1",
      userMessageId: "msg_user",
      assistantMessageId: "msg_assistant",
      agent: "build",
      model: { providerID: "pi", modelID: "virtual" },
      parts: [{ type: "text", text: "hello" }],
    })
    store.finishTurn({
      sessionId: "ses_1",
      assistantMessageId: "msg_assistant",
      outcome: { status: "completed", completedAt: 123 },
    })
    await store.flush()

    expect(sessions.at(-1)).toMatchObject({
      id: "ses_1",
      lastTurn: { status: "completed", completedAt: 123, assistantMessageId: "msg_assistant" },
    })
  })
})
