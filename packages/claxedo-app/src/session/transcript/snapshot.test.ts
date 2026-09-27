/// <reference types="bun" />
import { expect, spyOn, test } from "bun:test"
import { createEffect, createRoot, on } from "solid-js"
import { placementId, projectId, ServerError, sessionId, type Server, type SessionReads, type SessionOutline, type SessionRef, type TranscriptPage } from "@/server"
import { createRequests } from "../requests"
import { createTranscriptContext, type TranscriptDeps } from "./context"
import { loadOlder } from "./older"
import { readSnapshot } from "./snapshot"

const ref: SessionRef = { projectId: projectId("project-1"), placementId: placementId("placement-1"), sessionId: sessionId("ses_1") }

const entry = (id: string, role: "user" | "assistant", parts: readonly { readonly type: string; readonly id: string }[]) => ({
  info: { id, role, sessionID: "ses_1", time: { created: 1, completed: 2 }, ...(role === "assistant" ? { parentID: id.replace(/_r$/, "") } : {}) },
  parts: parts.map((part) => ({ ...part, messageID: id, sessionID: "ses_1", text: "" })),
})

const page = (entries: ReturnType<typeof entry>[], olderCursor?: string) => ({ entries, ...(olderCursor ? { olderCursor } : {}) }) as unknown as TranscriptPage

const surface = page([entry("msg_2", "user", [{ type: "text", id: "p1" }]), entry("msg_2_r", "assistant", [{ type: "text", id: "p3" }])], "before-the-reply")
const wholeTurn = page([entry("msg_2", "user", [{ type: "text", id: "p1" }]), entry("msg_2_r", "assistant", [{ type: "tool", id: "p2" }, { type: "text", id: "p3" }])], "before-the-turn")
const olderPage = page([entry("msg_1", "user", [{ type: "text", id: "p0" }])])
const olderTurn = page([entry("msg_1", "user", [{ type: "text", id: "p0" }]), entry("msg_1_r", "assistant", [{ type: "tool", id: "p8" }, { type: "text", id: "p9" }])])
const olderPages: TranscriptPage[] = [page([entry("msg_1_r", "assistant", [{ type: "text", id: "p9" }])], "before-msg-1"), olderPage]

function fakeServer(pages: readonly TranscriptPage[] = [olderPage], outlines: Promise<SessionOutline>[] = []) {
  const olderReads: string[] = []
  const turnReads: string[] = []
  const reads: SessionReads = {
    surface: Promise.resolve({ row: { ref, title: "Two turns", createdAt: 1, updatedAt: 2 }, diff: [], transcript: surface, latestTurnComplete: false }),
    outline: Promise.resolve(undefined),
    status: Promise.resolve({ kind: "idle" }),
    requests: Promise.resolve([]),
    todos: Promise.resolve([]),
    goal: Promise.resolve({ goal: undefined, actions: [], available: false }),
    subagents: Promise.resolve([]),
  } as unknown as SessionReads
  const server = {
    sessions: {
      read: () => ({ ...reads, outline: outlines.shift() ?? reads.outline }),
      wholeTurn: async (_ref: SessionRef, before?: string) => {
        if (before === undefined) return wholeTurn
        turnReads.push(before)
        return olderTurn
      },
      older: async (_ref: SessionRef, cursor: string) => {
        olderReads.push(cursor)
        return pages[olderReads.length - 1] ?? olderPage
      },
    },
  } as unknown as Server
  const deps = { list: { readRow: () => undefined, readStatus: () => undefined }, requests: { read: () => undefined, readFailed: () => undefined } } as unknown as TranscriptDeps
  return { server, deps, olderReads, turnReads }
}

test("snapshot: once the whole latest turn lands, older history pages from before the turn, not from the surface's cursor into it", async () => {
  const { server, deps, olderReads } = fakeServer()
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, ref, deps)
    await readSnapshot(context)
    expect(context.data.messages.map((message) => message.id)).toEqual(["msg_2", "msg_2_r"])
    expect(context.olderCursor()).toBe("before-the-turn")
    await loadOlder(context, "page")
    expect(olderReads).toEqual(["before-the-turn"])
    expect(context.data.messages.map((message) => message.id)).toEqual(["msg_1", "msg_2", "msg_2_r"])
    expect(context.olderCursor()).toBeUndefined()
    dispose()
  })
})

test("older: a page that lands is out of flight before it is announced, so a watcher of the landing can page again at once", async () => {
  const { server, deps, olderReads } = fakeServer(olderPages)
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, ref, deps)
    await readSnapshot(context)
    createEffect(
      on(
        () => context.older.state().kind,
        (kind) => {
          if (kind === "idle" && context.olderCursor() !== undefined) void loadOlder(context, "page")
        },
        { defer: true },
      ),
    )
    await loadOlder(context, "page")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(olderReads).toEqual(["before-the-turn", "before-msg-1"])
    expect(context.data.messages.map((message) => message.id)).toEqual(["msg_1", "msg_1_r", "msg_2", "msg_2_r"])
    expect(context.olderCursor()).toBeUndefined()
    dispose()
  })
})

test("snapshot: an outline read sent earlier that lands after a later one loses", async () => {
  const outline = (id: string): SessionOutline => ({ turns: [{ id, createdAt: 1, preview: {} }], complete: true })
  let landEarlier: (outline: SessionOutline) => void = () => {}
  const { server, deps } = fakeServer([olderPage], [new Promise<SessionOutline>((resolve) => (landEarlier = resolve)), Promise.resolve(outline("later"))])
  let now = 1_000
  const clock = spyOn(Date, "now").mockImplementation(() => (now += 1))
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, ref, deps)
    await readSnapshot(context)
    await readSnapshot(context)
    expect(context.outline.state()).toMatchObject({ kind: "ready", outline: outline("later") })
    landEarlier(outline("earlier"))
    await Promise.resolve()
    expect(context.outline.state()).toMatchObject({ kind: "ready", outline: outline("later") })
    dispose()
  })
  clock.mockRestore()
})

test("older: a whole-turn read pages from the same cursor, in the same slot, and lands the turn above like a page", async () => {
  const { server, deps, olderReads, turnReads } = fakeServer()
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, ref, deps)
    await readSnapshot(context)
    const turn = loadOlder(context, "turn")
    expect(loadOlder(context, "page"), "a page asked for while the turn is in flight joins it").toBe(turn)
    await turn
    expect(turnReads).toEqual(["before-the-turn"])
    expect(olderReads).toEqual([])
    expect(context.data.messages.map((message) => message.id)).toEqual(["msg_1", "msg_1_r", "msg_2", "msg_2_r"])
    expect(context.olderCursor()).toBeUndefined()
    expect(context.older.state().kind).toBe("idle")
    dispose()
  })
})

test("snapshot: a refused requests read leaves the transcript on screen and names the failure for its Retry, and the next read clears it", async () => {
  const refused = new ServerError({ class: "network", status: 502, code: "harness_engine_error", message: "The engine refused the permission list" })
  const answers = [Promise.reject(refused), Promise.resolve([])]
  const { server: base } = fakeServer()
  const server = { ...base, sessions: { ...base.sessions, read: () => ({ ...base.sessions.read(ref), requests: answers.shift()! }) } } as unknown as Server
  let now = 1_000
  const clock = spyOn(Date, "now").mockImplementation(() => (now += 1))
  await createRoot(async (dispose) => {
    const requests = createRequests(server)
    const context = createTranscriptContext(server, ref, { list: { readRow: () => undefined, readStatus: () => undefined }, requests } as unknown as TranscriptDeps)
    await readSnapshot(context)
    await Promise.resolve()
    expect(context.data.messages.map((message) => message.id)).toEqual(["msg_2", "msg_2_r"])
    expect(requests.readErrorFor(ref.sessionId)).toMatchObject({ status: 502, message: "The engine refused the permission list" })
    await readSnapshot(context)
    await Promise.resolve()
    expect(requests.readErrorFor(ref.sessionId)).toBeUndefined()
    dispose()
  })
  clock.mockRestore()
})
