/// <reference types="bun" />
import { expect, spyOn, test } from "bun:test"
import { createEffect, createRoot, on } from "solid-js"
import { placementId, projectId, ServerError, sessionId, type FoldedTurn, type Server, type SessionFirstRead, type SessionReads, type SessionRef, type TranscriptPage } from "@/server"
import { createRequests } from "../requests"
import { createTranscriptContext, type TranscriptDeps } from "./context"
import { readFoldedTurn } from "./latest-turn"
import { loadOlder } from "./older"
import { readSnapshot } from "./snapshot"

const ref: SessionRef = { projectId: projectId("project-1"), placementId: placementId("placement-1"), sessionId: sessionId("ses_1") }

const entry = (id: string, role: "user" | "assistant", parts: readonly { readonly type: string; readonly id: string }[]) => ({
  info: { id, role, sessionID: "ses_1", time: { created: 1, completed: 2 }, ...(role === "assistant" ? { parentID: id.replace(/_r$/, "") } : {}) },
  parts: parts.map((part) => ({ ...part, messageID: id, sessionID: "ses_1", text: "" })),
})

const page = (entries: ReturnType<typeof entry>[], olderCursor?: string) => ({ entries, ...(olderCursor ? { olderCursor } : {}) }) as unknown as TranscriptPage

const foldedLatest = page([entry("msg_2", "user", [{ type: "text", id: "p1" }]), entry("msg_2_r", "assistant", [{ type: "text", id: "p3" }])], "before-the-turn")
const wholeTurn = page([entry("msg_2", "user", [{ type: "text", id: "p1" }]), entry("msg_2_r", "assistant", [{ type: "tool", id: "p2" }, { type: "text", id: "p3" }])], "before-the-turn")
const olderPage = page([entry("msg_1", "user", [{ type: "text", id: "p0" }])])
const olderTurn = page([entry("msg_1", "user", [{ type: "text", id: "p0" }]), entry("msg_1_r", "assistant", [{ type: "tool", id: "p8" }, { type: "text", id: "p9" }])])
const olderPages: TranscriptPage[] = [page([entry("msg_1_r", "assistant", [{ type: "text", id: "p9" }])], "before-msg-1"), olderPage]
const outline = { turns: [{ id: "msg_1", createdAt: 1, preview: {} }, { id: "msg_2", createdAt: 1, preview: {} }], complete: true }

const firstRead = (transcript: TranscriptPage, folded: readonly (readonly [string, FoldedTurn])[]): SessionFirstRead => ({
  row: { ref, title: "Two turns", createdAt: 1, updatedAt: 2 },
  diff: [],
  outline,
  transcript,
  folded: new Map(folded),
  latestTurn: undefined,
})

function fakeServer(first: SessionFirstRead = firstRead(foldedLatest, [["msg_2", { foldableCount: 2 }]]), pages: readonly TranscriptPage[] = [olderPage]) {
  const olderReads: string[] = []
  const turnReads: (string | undefined)[] = []
  const reads = {
    first: Promise.resolve(first),
    status: Promise.resolve({ kind: "idle" }),
    requests: Promise.resolve([]),
    todos: Promise.resolve([]),
    goal: Promise.resolve({ goal: undefined, actions: [], available: false }),
    subagents: Promise.resolve([]),
  } as unknown as SessionReads
  const server = {
    sessions: {
      read: () => reads,
      wholeTurn: async (_ref: SessionRef, before?: string) => {
        turnReads.push(before)
        return before === undefined ? wholeTurn : olderTurn
      },
      older: async (_ref: SessionRef, cursor: string) => {
        olderReads.push(cursor)
        return pages[olderReads.length - 1] ?? olderPage
      },
    },
  } as unknown as Server
  const deps = {
    list: { readRow: () => undefined, readStatus: () => undefined },
    requests: { read: () => undefined, readFailed: () => undefined },
    firstPage: () => ({ rows: 40, cols: 100, reasoning: false }),
  } as unknown as TranscriptDeps
  return { server, deps, olderReads, turnReads }
}

const idle = () => new Promise((resolve) => setTimeout(resolve, 5))

test("snapshot: a first read lands its row, outline and page in one update, and a latest turn that arrived folded reads whole once the main thread is idle", async () => {
  const { server, deps, olderReads, turnReads } = fakeServer()
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, ref, deps)
    const seen: string[] = []
    createEffect(
      on(
        () => [context.phase.state().kind, context.data.messages.length, context.outline().kind, context.data.folded.size] as const,
        (state) => seen.push(state.join(" ")),
      ),
    )
    await readSnapshot(context)
    expect(seen, "the row, page, outline and fold land together").toEqual(["loading 0 loading 0", "ready 2 ready 1"])
    expect(context.olderCursor()).toBe("before-the-turn")
    expect(turnReads, "nothing more is read before the main thread is idle").toEqual([])

    await idle()
    expect(turnReads).toEqual([undefined])
    expect(context.data.parts["msg_2_r"]?.map((part) => part.id)).toEqual(["p2", "p3"])
    expect(context.data.folded.size).toBe(0)
    expect(context.latestTurnRead.current).toBe(wholeTurn)

    await loadOlder(context, "page")
    expect(olderReads).toEqual(["before-the-turn"])
    expect(context.data.messages.map((message) => message.id)).toEqual(["msg_1", "msg_2", "msg_2_r"])
    expect(context.olderCursor()).toBeUndefined()
    dispose()
  })
})

test("snapshot: a folded older turn reads whole from the next turn's cursor when its reader opens it, once however often it is asked", async () => {
  const oldestFolded = page([entry("msg_1", "user", [{ type: "text", id: "p0" }]), entry("msg_1_r", "assistant", [{ type: "text", id: "p9" }]), ...wholeTurn.entries.map((item) => item as ReturnType<typeof entry>)])
  const { server, deps, turnReads } = fakeServer(firstRead(oldestFolded, [["msg_1", { foldableCount: 3, wholeBefore: "at-msg-2" }]]))
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, ref, deps)
    await readSnapshot(context)
    await idle()
    expect(turnReads, "a whole latest turn is never read again").toEqual([])
    await Promise.all([readFoldedTurn(context, "msg_1"), readFoldedTurn(context, "msg_1")])
    expect(turnReads).toEqual(["at-msg-2"])
    expect(context.data.parts["msg_1_r"]?.map((part) => part.id)).toEqual(["p8", "p9"])
    expect(context.data.folded.size).toBe(0)
    dispose()
  })
})

test("older: a page that lands is out of flight before it is announced, so a watcher of the landing can page again at once", async () => {
  const { server, deps, olderReads } = fakeServer(undefined, olderPages)
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
    await idle()
    expect(olderReads).toEqual(["before-the-turn", "before-msg-1"])
    expect(context.data.messages.map((message) => message.id)).toEqual(["msg_1", "msg_1_r", "msg_2", "msg_2_r"])
    expect(context.olderCursor()).toBeUndefined()
    dispose()
  })
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
  const { server: base, deps } = fakeServer()
  const server = { ...base, sessions: { ...base.sessions, read: () => ({ ...base.sessions.read(ref, deps.firstPage()), requests: answers.shift()! }) } } as unknown as Server
  let now = 1_000
  const clock = spyOn(Date, "now").mockImplementation(() => (now += 1))
  await createRoot(async (dispose) => {
    const requests = createRequests(server)
    const context = createTranscriptContext(server, ref, { ...deps, requests } as unknown as TranscriptDeps)
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
