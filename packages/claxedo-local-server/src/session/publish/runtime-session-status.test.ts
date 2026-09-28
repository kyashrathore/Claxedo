import { describe, expect, test, vi } from "vitest"
import type { RuntimeStatusPath } from "../runtime-activity"
import { createRuntimeSessionStatus } from "./runtime-session-status"

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
    onChange: (workspaceId, sessionId) => changes.push([workspaceId, sessionId]),
  })
  const emit = (type: string, properties: Record<string, unknown>) => {
    for (const listener of frameListeners) listener({ directory: "/work", payload: { type, properties } })
  }
  return {
    status,
    changes,
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
    h.emit("session.status", { sessionID: "s2", status: { type: "recovering" } })
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
