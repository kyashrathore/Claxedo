import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import { createStore } from "solid-js/store"
import type { State } from "./types"
import { applyDirectoryEvent, cleanupDroppedSessionCaches } from "./event-reducer"
import { clearOpenSessions, setOpenSessions } from "./open-sessions"

const root = (id: string, archived?: number) =>
  ({
    id,
    time: {
      created: 1,
      updated: 1,
      archived,
    },
  }) as Session

const msg = (id: string, sessionId: string) =>
  ({
    id,
    sessionID: sessionId,
    role: "user",
    time: { created: 1 },
    agent: "assistant",
    model: { providerID: "openai", modelID: "gpt" },
  }) as Message

const part = (id: string, sessionId: string, messageId: string) =>
  ({
    id,
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text: id,
  }) as Part

function state(input: Partial<State> = {}) {
  return createStore<State>({
    status: "complete",
    agent: [],
    command: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider_ready: false,
    provider: { all: [], connected: [], default: {} },
    config: {},
    path: { state: "", config: "", worktree: "", directory: "/tmp/ws", home: "" },
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp_ready: false,
    mcp: {},
    lsp_ready: false,
    lsp: [],
    vcs: undefined,
    limit: 1,
    message: {},
    part: {},
    session_agent: {},
    session_config: {},
    session_usage: {},
    ...input,
  })
}

function fill(sessionId: string) {
  const message = msg(`msg-${sessionId}`, sessionId)
  return {
    message,
    part: part(`part-${sessionId}`, sessionId, message.id),
  }
}

beforeEach(() => clearOpenSessions())
afterEach(() => clearOpenSessions())

describe("claxedo cleanupDroppedSessionCaches", () => {
  test("keeps every cache bucket for an open session outside the keep set", () => {
    const live = fill("ses_live")
    const dead = fill("ses_dead")
    const calls: Array<string | undefined> = []
    const [store, setStore] = state({
      message: {
        ses_live: [live.message],
        ses_dead: [dead.message],
      },
      part: {
        [live.message.id]: [live.part],
        [dead.message.id]: [dead.part],
      },
      session_diff: { ses_live: [], ses_dead: [] },
      todo: { ses_live: [], ses_dead: [] },
      permission: { ses_live: [], ses_dead: [] },
      question: { ses_live: [], ses_dead: [] },
      session_status: {
        ses_live: { type: "busy" } as State["session_status"][string],
        ses_dead: { type: "busy" } as State["session_status"][string],
      },
      session_agent: { ses_live: "codex", ses_dead: "claude" },
      session_config: { ses_live: [{ id: "model" }], ses_dead: [{ id: "model" }] },
      session_usage: {
        ses_live: { contextSize: 10, contextUsed: 2 },
        ses_dead: { contextSize: 10, contextUsed: 2 },
      },
    })
    setOpenSessions([{ directory: "/tmp/ws", sessionId: "ses_live" }])

    cleanupDroppedSessionCaches(
      store,
      setStore,
      [root("ses_keep")],
      (sessionId, todos) => {
        calls.push(`${sessionId}:${todos === undefined ? "clear" : "keep"}`)
      },
      "/tmp/ws",
    )

    expect(store.message.ses_live).toEqual([live.message])
    expect(store.part[live.message.id]).toEqual([live.part])
    expect(store.session_diff.ses_live).toEqual([])
    expect(store.todo.ses_live).toEqual([])
    expect(store.permission.ses_live).toEqual([])
    expect(store.question.ses_live).toEqual([])
    expect(store.session_status.ses_live).toEqual({ type: "busy" })
    expect(store.session_agent.ses_live).toBe("codex")
    expect(store.session_config.ses_live).toEqual([{ id: "model" }])
    expect(store.session_usage.ses_live).toEqual({ contextSize: 10, contextUsed: 2 })

    expect(store.message.ses_dead).toBeUndefined()
    expect(store.part[dead.message.id]).toBeUndefined()
    expect(store.session_diff.ses_dead).toBeUndefined()
    expect(store.todo.ses_dead).toBeUndefined()
    expect(store.permission.ses_dead).toBeUndefined()
    expect(store.question.ses_dead).toBeUndefined()
    expect(store.session_status.ses_dead).toBeUndefined()
    expect(store.session_agent.ses_dead).toBeUndefined()
    expect(store.session_config.ses_dead).toBeUndefined()
    expect(store.session_usage.ses_dead).toBeUndefined()
    expect(calls).toEqual(["ses_dead:clear"])
  })

  test("evicts a session that is not kept and not open", () => {
    const stale = fill("ses_stale")
    const [store, setStore] = state({
      message: { ses_stale: [stale.message] },
      part: { [stale.message.id]: [stale.part] },
      session_diff: { ses_stale: [] },
      todo: { ses_stale: [] },
      permission: { ses_stale: [] },
      question: { ses_stale: [] },
      session_status: { ses_stale: { type: "busy" } as State["session_status"][string] },
      session_agent: { ses_stale: "codex" },
      session_config: { ses_stale: [{ id: "model" }] },
      session_usage: { ses_stale: { contextSize: 1, contextUsed: 1 } },
    })

    cleanupDroppedSessionCaches(store, setStore, [root("ses_keep")], undefined, "/tmp/ws")

    expect(store.message.ses_stale).toBeUndefined()
    expect(store.part[stale.message.id]).toBeUndefined()
    expect(store.session_diff.ses_stale).toBeUndefined()
    expect(store.todo.ses_stale).toBeUndefined()
    expect(store.permission.ses_stale).toBeUndefined()
    expect(store.question.ses_stale).toBeUndefined()
    expect(store.session_status.ses_stale).toBeUndefined()
    expect(store.session_agent.ses_stale).toBeUndefined()
    expect(store.session_config.ses_stale).toBeUndefined()
    expect(store.session_usage.ses_stale).toBeUndefined()
  })

  test("keeps a just-created sidebar tab session when loadSessions cleanup runs afterward", () => {
    const live = fill("ses_new")
    const [store, setStore] = state({
      message: { ses_new: [live.message] },
      part: { [live.message.id]: [live.part] },
      todo: { ses_new: [] },
    })
    setOpenSessions([{ directory: "/tmp/ws", sessionId: "ses_new" }])

    cleanupDroppedSessionCaches(store, setStore, [root("ses_keep")], undefined, "/tmp/ws")

    expect(store.message.ses_new).toEqual([live.message])
    expect(store.part[live.message.id]).toEqual([live.part])
    expect(store.todo.ses_new).toEqual([])
  })

  test("allows eviction after the last tab for a session closes", () => {
    const live = fill("ses_live")
    const [store, setStore] = state({
      message: { ses_live: [live.message] },
      part: { [live.message.id]: [live.part] },
    })
    setOpenSessions([{ directory: "/tmp/ws", sessionId: "ses_live" }])

    cleanupDroppedSessionCaches(store, setStore, [root("ses_keep")], undefined, "/tmp/ws")
    expect(store.message.ses_live).toEqual([live.message])

    clearOpenSessions()
    cleanupDroppedSessionCaches(store, setStore, [root("ses_keep")], undefined, "/tmp/ws")

    expect(store.message.ses_live).toBeUndefined()
    expect(store.part[live.message.id]).toBeUndefined()
  })

  test("keeps multiple open session tabs across groups independently", () => {
    const a = fill("ses_a")
    const b = fill("ses_b")
    const [store, setStore] = state({
      message: { ses_a: [a.message], ses_b: [b.message] },
      part: { [a.message.id]: [a.part], [b.message.id]: [b.part] },
    })
    setOpenSessions([
      { directory: "/tmp/ws", sessionId: "ses_a" },
      { directory: "/tmp/ws", sessionId: "ses_b" },
    ])

    cleanupDroppedSessionCaches(store, setStore, [root("ses_keep")], undefined, "/tmp/ws")

    expect(store.message.ses_a).toEqual([a.message])
    expect(store.message.ses_b).toEqual([b.message])
    expect(store.part[a.message.id]).toEqual([a.part])
    expect(store.part[b.message.id]).toEqual([b.part])
  })
})

describe("claxedo applyDirectoryEvent", () => {
  test("session.created does not evict an open session outside the trimmed set", () => {
    const live = fill("ses_z")
    const [store, setStore] = state({
      session: [root("ses_z")],
      sessionTotal: 1,
      message: { ses_z: [live.message] },
      part: { [live.message.id]: [live.part] },
      todo: { ses_z: [] },
    })
    setOpenSessions([{ directory: "/tmp/ws", sessionId: "ses_z" }])

    applyDirectoryEvent({
      event: { type: "session.created", properties: { info: root("ses_a") } },
      store,
      setStore,
      push() {},
      directory: "/tmp/ws",
      loadLsp() {},
    })

    expect(store.session.map((item) => item.id)).toEqual(["ses_a"])
    expect(store.sessionTotal).toBe(2)
    expect(store.message.ses_z).toEqual([live.message])
    expect(store.part[live.message.id]).toEqual([live.part])
    expect(store.todo.ses_z).toEqual([])
  })

  test("session.updated does not evict an open session outside the trimmed set", () => {
    const live = fill("ses_z")
    const [store, setStore] = state({
      session: [root("ses_z")],
      sessionTotal: 1,
      message: { ses_z: [live.message] },
      part: { [live.message.id]: [live.part] },
      todo: { ses_z: [] },
    })
    setOpenSessions([{ directory: "/tmp/ws", sessionId: "ses_z" }])

    applyDirectoryEvent({
      event: { type: "session.updated", properties: { info: root("ses_a") } },
      store,
      setStore,
      push() {},
      directory: "/tmp/ws",
      loadLsp() {},
    })

    expect(store.session.map((item) => item.id)).toEqual(["ses_a"])
    expect(store.message.ses_z).toEqual([live.message])
    expect(store.part[live.message.id]).toEqual([live.part])
    expect(store.todo.ses_z).toEqual([])
  })
})
