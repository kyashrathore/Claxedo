import { describe, expect, test, vi } from "vitest"
import type { RuntimeStatusPath } from "../runtime-activity"
import { createRuntimeSessionStatus } from "./runtime-session-status"
import { createSessionRowsPublisher } from "./session-rows-publisher"

const WS = "ws_a"

type Listener = (runtime: { workspace: { id: string }; frames: { subscribe(fn: (frame: unknown) => void): () => void } }, phase: "mounted" | "retired" | "disposed") => void

function harness(answers: Partial<Record<RuntimeStatusPath, unknown>> = {}) {
  const listeners = new Set<Listener>()
  const frameListeners = new Set<(frame: unknown) => void>()
  const runtime = {
    workspace: { id: WS },
    frames: {
      subscribe: (fn: (frame: unknown) => void) => {
        frameListeners.add(fn)
        return () => frameListeners.delete(fn)
      },
    },
  }
  const changes: Array<[string, string]> = []
  const changeListeners = new Set<(workspaceId: string, sessionId: string) => void>()
  let clock = 1_000
  const reads: RuntimeStatusPath[] = []
  const status = createRuntimeSessionStatus({
    observe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    read: async (_workspaceId, path) => {
      reads.push(path)
      const answer = answers[path]
      return answer === undefined ? undefined : Response.json(answer)
    },
    now: () => clock,
    onChange: (workspaceId, sessionId) => {
      changes.push([workspaceId, sessionId])
      for (const listener of changeListeners) listener(workspaceId, sessionId)
    },
  })
  const emit = (type: string, properties: Record<string, unknown>) => {
    for (const listener of frameListeners) listener({ directory: "/work", payload: { type, properties } })
  }
  return {
    status,
    changes,
    changeListeners,
    reads,
    emit,
    tick: (ms: number) => {
      clock += ms
    },
    mount: () => listeners.forEach((listener) => listener(runtime, "mounted")),
    dispose: () => listeners.forEach((listener) => listener(runtime, "disposed")),
    subscribed: () => frameListeners.size,
  }
}

function onChangeOf(h: ReturnType<typeof harness>, listener: (workspaceId: string, sessionId: string) => void) {
  h.changeListeners.add(listener)
  return () => h.changeListeners.delete(listener)
}

async function until(ready: () => boolean) {
  for (let attempt = 0; attempt < 200 && !ready(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(ready()).toBe(true)
}

describe("runtime session status", () => {
  test("a session never seen is idle as of now", () => {
    const h = harness()
    expect(h.status.current(WS, "s1")).toEqual({ kind: "idle", awaitingInput: false, at: 1_000 })
  })

  test("follows status, idle and error frames, reporting each change once", () => {
    const h = harness()
    h.mount()

    h.emit("session.status", { sessionID: "s1", status: { type: "busy" } })
    h.tick(10)
    h.emit("session.status", { sessionID: "s1", status: { type: "busy" } })
    expect(h.status.current(WS, "s1")).toEqual({ kind: "busy", awaitingInput: false, at: 1_000 })

    h.emit("session.status", { sessionID: "s1", status: { type: "retry", attempt: 1 } })
    expect(h.status.current(WS, "s1").kind).toBe("retry")
    h.emit("session.idle", { sessionID: "s1" })
    expect(h.status.current(WS, "s1")).toEqual({ kind: "idle", awaitingInput: false, at: 1_010 })
    h.emit("session.status", { sessionID: "s2", status: { type: "interrupted" } })
    h.emit("session.error", { sessionID: "s2", error: { message: "gone" } })

    expect(h.changes).toEqual([[WS, "s1"], [WS, "s1"], [WS, "s1"], [WS, "s2"], [WS, "s2"]])
  })

  test("an open permission or question is awaiting input until its reply", () => {
    const h = harness()
    h.mount()

    h.emit("permission.asked", { id: "p1", sessionID: "s1", permission: "bash" })
    h.emit("question.asked", { id: "q1", sessionID: "s1", questions: [] })
    expect(h.status.current(WS, "s1").awaitingInput).toBe(true)

    h.emit("permission.replied", { sessionID: "s1", requestID: "p1", reply: "once" })
    expect(h.status.current(WS, "s1").awaitingInput, "the question is still open").toBe(true)
    h.emit("question.rejected", { sessionID: "s1", requestID: "q1" })
    expect(h.status.current(WS, "s1").awaitingInput).toBe(false)

    expect(h.changes).toEqual([[WS, "s1"], [WS, "s1"]])
  })

  test("a stopped turn's expired permission and question no longer await input", () => {
    const h = harness()
    h.mount()
    h.emit("permission.asked", { id: "p1", sessionID: "s1", permission: "bash" })
    h.emit("question.asked", { id: "q1", sessionID: "s1", questions: [] })

    h.emit("permission.expired", { sessionID: "s1", requestID: "p1" })
    expect(h.status.current(WS, "s1").awaitingInput, "the question is still open").toBe(true)
    h.emit("question.expired", { sessionID: "s1", requestID: "q1" })
    expect(h.status.current(WS, "s1").awaitingInput).toBe(false)

    expect(h.changes).toEqual([[WS, "s1"], [WS, "s1"]])
  })

  test("frames without a session, and frames of other kinds, change nothing", () => {
    const h = harness()
    h.mount()

    h.emit("session.error", { error: { message: "global" } })
    h.emit("message.part.updated", { sessionID: "s1", part: {} })
    h.emit("session.status", {})

    expect(h.changes).toEqual([])
  })

  test("reports background work when its counts change, and carries it on the row while it runs", () => {
    const h = harness()
    h.mount()

    h.emit("session.background-work", { sessionID: "s1", agents: 1, shells: 0, other: 0 })
    h.emit("session.background-work", { sessionID: "s1", agents: 1, shells: 0, other: 0 })
    expect(h.status.current(WS, "s1")).toEqual({ kind: "idle", awaitingInput: false, backgroundWork: { agents: 1, shells: 0, other: 0 }, at: 1_000 })
    h.emit("session.background-work", { sessionID: "s1", agents: 0, shells: 0, other: 0 })
    expect(h.status.current(WS, "s1")).toEqual({ kind: "idle", awaitingInput: false, at: 1_000 })

    expect(h.changes).toEqual([[WS, "s1"], [WS, "s1"]])
  })

  test("a turn's streamed content publishes nothing; only its status change does", async () => {
    const h = harness()
    const posts: unknown[] = []
    const publisher = createSessionRowsPublisher({
      source: {
        listRows: async () => [],
        readRow: async (workspaceId, sessionId) => ({
          kind: "row",
          row: { workspaceId, sessionId, createdAt: 1, updatedAt: 1, status: h.status.current(workspaceId, sessionId) },
        }),
      },
      url: () => "https://plane.test/api/claxedo/host/session-rows",
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        posts.push(JSON.parse(typeof init?.body === "string" ? init.body : ""))
        return Response.json({ accepted: 1, refused: [] })
      }) as typeof fetch,
      debounceMs: 1,
    })
    publisher.credentialChanged({ token: "htt", hostId: "host_1", workspaceIds: [WS] })
    const unsubscribe = onChangeOf(h, (workspaceId, sessionId) => publisher.sessionChanged(workspaceId, sessionId))
    h.mount()

    for (let index = 0; index < 50; index += 1) {
      h.emit("message.part.updated", { sessionID: "s1", part: { id: `p${index}`, type: "text", text: "x".repeat(index) } })
      h.emit("message.part.delta", { sessionID: "s1", messageID: "m1", partID: "p1", field: "text", delta: "x" })
      h.emit("message.updated", { sessionID: "s1", info: { id: "m1", sessionID: "s1", role: "assistant" } })
    }
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(posts).toEqual([])

    h.emit("session.status", { sessionID: "s1", status: { type: "busy" } })
    await until(() => posts.length === 1)
    expect(posts[0]).toMatchObject({ rows: [{ sessionId: "s1", status: { kind: "busy" } }] })
    unsubscribe()
    publisher.stop()
  })

  test("a disposed runtime leaves every session idle and says so for the ones that were not", () => {
    const h = harness()
    h.mount()
    h.emit("session.status", { sessionID: "busy", status: { type: "busy" } })
    h.emit("session.status", { sessionID: "idle", status: { type: "busy" } })
    h.emit("session.idle", { sessionID: "idle" })
    h.changes.length = 0

    h.dispose()

    expect(h.changes).toEqual([[WS, "busy"]])
    expect(h.status.current(WS, "busy").kind).toBe("idle")
    expect(h.subscribed()).toBe(0)
  })

  test("a snapshot reads the runtime in process and replaces what the frames said", async () => {
    const h = harness({
      "/session/status": { s1: { type: "busy" }, s3: { type: "idle" } },
      "/permission": [{ id: "p1", sessionID: "s2", permission: "bash" }],
      "/question": [{ id: "q1", sessionID: "s1", questions: [] }],
    })
    h.mount()
    h.emit("session.status", { sessionID: "s9", status: { type: "busy" } })
    h.tick(500)

    const live = await h.status.snapshot(WS)

    expect(live).toEqual(new Map([
      ["s1", { kind: "busy", awaitingInput: true, at: 1_500 }],
      ["s3", { kind: "idle", awaitingInput: false, at: 1_500 }],
      ["s2", { kind: "idle", awaitingInput: true, at: 1_500 }],
    ]))
    expect(h.reads).toEqual(["/session/status", "/permission", "/question"])
    expect(h.status.current(WS, "s9"), "a session the runtime no longer reports is idle").toMatchObject({ kind: "idle" })

    h.emit("question.replied", { sessionID: "s1", requestID: "q1", answers: [] })
    expect(h.status.current(WS, "s1").awaitingInput, "later frames build on the snapshot").toBe(false)
  })

  test("a workspace with no runtime up has nothing live", async () => {
    const h = harness()
    h.mount()
    h.emit("session.status", { sessionID: "s1", status: { type: "busy" } })

    expect(await h.status.snapshot(WS)).toEqual(new Map())
    expect(h.status.current(WS, "s1").kind).toBe("idle")
  })

  test("a runtime that refuses the read fails the snapshot rather than answering idle", async () => {
    const h = harness()
    h.mount()
    const failing = createRuntimeSessionStatus({
      observe: () => () => undefined,
      read: async () => new Response("no", { status: 503 }),
      onChange: vi.fn(),
    })

    await expect(failing.snapshot(WS)).rejects.toThrow(/503/)
  })
})
