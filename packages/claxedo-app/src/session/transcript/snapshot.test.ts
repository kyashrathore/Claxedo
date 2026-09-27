/// <reference types="bun" />
import { expect, spyOn, test } from "bun:test"
import { createEffect, createRoot, on } from "solid-js"
import { placementId, projectId, ServerError, sessionId, type FoldedTurn, type Server, type SessionFirstRead, type SessionReads, type SessionRef, type TranscriptPage, type TurnPageRead } from "@/server"
import { createRequests } from "../requests"
import { createTranscriptContext, type TranscriptDeps } from "./context"
import { openFoldedTurn } from "./folded-turn"
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
const pageRead = (transcript: TranscriptPage, folded: readonly (readonly [string, FoldedTurn])[] = []): TurnPageRead => ({ transcript, folded: new Map(folded) })
const olderPages: TurnPageRead[] = [pageRead(page([entry("msg_1_r", "assistant", [{ type: "text", id: "p9" }])], "before-msg-1")), pageRead(olderPage)]
const outline = { turns: [{ id: "msg_1", createdAt: 1, preview: {} }, { id: "msg_2", createdAt: 1, preview: {} }], complete: true }

const firstRead = (transcript: TranscriptPage, folded: readonly (readonly [string, FoldedTurn])[]): SessionFirstRead => ({
  row: { ref, title: "Two turns", createdAt: 1, updatedAt: 2 },
  diff: [],
  outline,
  transcript,
  folded: new Map(folded),
  latestTurn: undefined,
})

function fakeServer(first: SessionFirstRead = firstRead(foldedLatest, [["msg_2", { foldableCount: 2 }]]), pages: readonly TurnPageRead[] = [pageRead(olderPage)], turns: (before?: string) => TranscriptPage = (before) => (before === undefined ? wholeTurn : olderTurn)) {
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
      openTurn: async (_ref: SessionRef, _settings: unknown, before?: string) => {
        turnReads.push(before)
        return turns(before)
      },
      page: async (_ref: SessionRef, _shape: unknown, cursor: string) => {
        olderReads.push(cursor)
        return pages[olderReads.length - 1] ?? pageRead(olderPage)
      },
    },
  } as unknown as Server
  const deps = {
    list: { readRow: () => undefined, readStatus: () => undefined },
    requests: { read: () => undefined, readFailed: () => undefined },
    pageShape: () => ({ rows: 40, cols: 100, reasoning: false, shell: false, edit: false }),
  } as unknown as TranscriptDeps
  return { server, deps, olderReads, turnReads }
}

const idle = () => new Promise((resolve) => setTimeout(resolve, 5))

test("snapshot: a first read lands its row, outline and page in one update, and nothing more is read until the reader opens a fold or pages", async () => {
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
    await idle()
    expect(turnReads, "an idle transcript reads nothing").toEqual([])
    expect(olderReads).toEqual([])

    await Promise.all([openFoldedTurn(context, "msg_2"), openFoldedTurn(context, "msg_2")])
    expect(turnReads, "opening the newest turn's fold reads it once").toEqual([undefined])
    expect(context.data.parts["msg_2_r"]?.map((part) => part.id)).toEqual(["p2", "p3"])
    expect(context.data.folded.size).toBe(0)
    expect(context.latestTurnRead.current).toBe(wholeTurn)

    await loadOlder(context)
    expect(olderReads).toEqual(["before-the-turn"])
    expect(context.data.messages.map((message) => message.id)).toEqual(["msg_1", "msg_2", "msg_2_r"])
    expect(context.olderCursor()).toBeUndefined()
    dispose()
  })
})

test("snapshot: a folded older turn opens from the next turn's cursor when its reader opens it, once however often it is asked", async () => {
  const oldestFolded = page([entry("msg_1", "user", [{ type: "text", id: "p0" }]), entry("msg_1_r", "assistant", [{ type: "text", id: "p9" }]), ...wholeTurn.entries.map((item) => item as ReturnType<typeof entry>)])
  const { server, deps, turnReads } = fakeServer(firstRead(oldestFolded, [["msg_1", { foldableCount: 3, openBefore: "at-msg-2" }]]))
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, ref, deps)
    await readSnapshot(context)
    await Promise.all([openFoldedTurn(context, "msg_1"), openFoldedTurn(context, "msg_1")])
    expect(turnReads).toEqual(["at-msg-2"])
    expect(context.data.parts["msg_1_r"]?.map((part) => part.id)).toEqual(["p8", "p9"])
    expect(context.data.folded.size).toBe(0)
    dispose()
  })
})

test("snapshot: a turn that arrived as the newest and is no longer the newest opens by reading back from the newest to it", async () => {
  const newer = page([entry("msg_3", "user", [{ type: "text", id: "p5" }]), entry("msg_3_r", "assistant", [{ type: "text", id: "p6" }])], "at-msg-3")
  const { server, deps, turnReads } = fakeServer(undefined, undefined, (before) => (before === undefined ? newer : wholeTurn))
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, ref, deps)
    await readSnapshot(context)
    context.setData("messages", (messages) => [...messages, newer.entries[0]!.info as never])
    await openFoldedTurn(context, "msg_2")
    expect(turnReads).toEqual([undefined, "at-msg-3"])
    expect(context.data.parts["msg_2_r"]?.map((part) => part.id)).toEqual(["p2", "p3"])
    expect(context.data.folded.size).toBe(0)
    dispose()
  })
})

test("older: a page lands its folded turns, each opening before the turn after it and its last before the cursor it was read before", async () => {
  const folded = pageRead(page([entry("msg_1", "user", [{ type: "text", id: "p0" }]), entry("msg_1_r", "assistant", [{ type: "text", id: "p9" }])]), [["msg_1", { foldableCount: 2, openBefore: "before-the-turn" }]])
  const { server, deps } = fakeServer(undefined, [folded])
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, ref, deps)
    await readSnapshot(context)
    await loadOlder(context)
    expect([...context.data.folded]).toEqual([["msg_2", { foldableCount: 2 }], ["msg_1", { foldableCount: 2, openBefore: "before-the-turn" }]])
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
          if (kind === "idle" && context.olderCursor() !== undefined) void loadOlder(context)
        },
        { defer: true },
      ),
    )
    await loadOlder(context)
    await idle()
    expect(olderReads).toEqual(["before-the-turn", "before-msg-1"])
    expect(context.data.messages.map((message) => message.id)).toEqual(["msg_1", "msg_1_r", "msg_2", "msg_2_r"])
    expect(context.olderCursor()).toBeUndefined()
    dispose()
  })
})

test("snapshot: a refused requests read leaves the transcript on screen and names the failure for its Retry, and the next read clears it", async () => {
  const refused = new ServerError({ class: "network", status: 502, code: "harness_engine_error", message: "The engine refused the permission list" })
  const answers = [Promise.reject(refused), Promise.resolve([])]
  const { server: base, deps } = fakeServer()
  const server = { ...base, sessions: { ...base.sessions, read: () => ({ ...base.sessions.read(ref, deps.pageShape()), requests: answers.shift()! }) } } as unknown as Server
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
