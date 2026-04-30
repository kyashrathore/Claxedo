import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import type { State } from "../../overrides/context/global-sync/types"
import { resolveStoredMessages, shouldHydrateSession, syncSessionMeta } from "./session-controller"

function state() {
  return createStore<State>({
    status: "loading",
    agent: [],
    command: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider_ready: false,
    provider: { all: [], connected: [], default: {} },
    config: {},
    path: { state: "", config: "", worktree: "", directory: "", home: "" },
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
    limit: 5,
    message: {},
    part: {},
    session_agent: {},
    session_config: {},
    session_usage: {},
  })
}

describe("session controller helpers", () => {
  test("shouldHydrateSession skips invalid routes and hydrates real sessions", () => {
    expect(shouldHydrateSession({ sessionID: undefined, healthy: true })).toBe(false)
    expect(shouldHydrateSession({ sessionID: "new", healthy: true })).toBe(false)
    expect(shouldHydrateSession({ sessionID: "ses_1", healthy: false })).toBe(false)
    expect(shouldHydrateSession({ sessionID: "ses_1", previousSessionID: "new", healthy: true })).toBe(true)
    expect(shouldHydrateSession({ sessionID: "ses_1", previousSessionID: "ses_0", healthy: true })).toBe(true)
  })

  test("syncSessionMeta preserves local busy and filters lists to one session", async () => {
    const [store, setStore] = state()
    setStore("session_status", "ses_1", { type: "busy" } as any)

    const ok = await syncSessionMeta({
      sessionID: "ses_1",
      currentSessionID: () => "ses_1",
      sdk: {
        session: {
          status: async () => ({ data: { ses_1: { type: "idle" } as any, ses_2: { type: "busy" } as any } }),
        },
        permission: {
          list: async () => ({ data: [{ id: "p2", sessionID: "ses_2" }, { id: "p1", sessionID: "ses_1" }] as any }),
        },
        question: {
          list: async () => ({ data: [{ id: "q2", sessionID: "ses_2" }, { id: "q1", sessionID: "ses_1" }] as any }),
        },
      },
      setStore: (fn) => setStore(fn as any),
    })

    expect(ok).toBe(true)
    expect(store.session_status.ses_1).toEqual({ type: "busy" })
    expect(store.permission.ses_1?.map((item) => item.id)).toEqual(["p1"])
    expect(store.question.ses_1?.map((item) => item.id)).toEqual(["q1"])
  })

  test("syncSessionMeta ignores late results after session switch", async () => {
    const [store, setStore] = state()

    const ok = await syncSessionMeta({
      sessionID: "ses_1",
      currentSessionID: () => "ses_2",
      sdk: {
        session: {
          status: async () => ({ data: { ses_1: { type: "busy" } as any } }),
        },
        permission: {
          list: async () => ({ data: [{ id: "p1", sessionID: "ses_1" }] as any }),
        },
        question: {
          list: async () => ({ data: [{ id: "q1", sessionID: "ses_1" }] as any }),
        },
      },
      setStore: (fn) => setStore(fn as any),
    })

    expect(ok).toBe(false)
    expect(store.session_status.ses_1).toBeUndefined()
    expect(store.permission.ses_1).toBeUndefined()
    expect(store.question.ses_1).toBeUndefined()
  })

  test("resolveStoredMessages keeps visible messages when replace fetch is empty", () => {
    expect(
      resolveStoredMessages({
        existing: [{ id: "msg_1" }, { id: "msg_2" }] as any,
        next: [],
      }).map((message) => message.id),
    ).toEqual(["msg_1", "msg_2"])
  })

  test("resolveStoredMessages still replaces when fetch returns rows", () => {
    expect(
      resolveStoredMessages({
        existing: [{ id: "msg_old" }] as any,
        next: [{ id: "msg_new" }] as any,
      }).map((message) => message.id),
    ).toEqual(["msg_new"])
  })

  test("resolveStoredMessages prepends without dropping existing rows", () => {
    expect(
      resolveStoredMessages({
        existing: [{ id: "msg_2" }] as any,
        next: [{ id: "msg_1" }] as any,
        mode: "prepend",
      }).map((message) => message.id),
    ).toEqual(["msg_1", "msg_2"])
  })
})
