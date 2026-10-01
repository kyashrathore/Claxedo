/// <reference types="bun" />
import { expect, spyOn, test } from "bun:test"
import { createEffect, createRoot, on } from "solid-js"
import { placementId, projectId, ServerError, sessionId, type Server, type SessionFirstRead, type SessionReads, type SessionRef, type TranscriptPage, type TranscriptPart } from "@/server"
import { createRequests } from "../requests"
import { createTranscriptContext, type TranscriptDeps } from "./context"
import { loadOlder } from "./older"
import { loadPart } from "./part"
import { readSnapshot } from "./snapshot"

const ref: SessionRef = { projectId: projectId("project-1"), placementId: placementId("placement-1"), sessionId: sessionId("ses_1") }

const entry = (id: string, role: "user" | "assistant", parts: readonly { readonly type: string; readonly id: string }[]) => ({
  info: { id, role, sessionID: "ses_1", time: { created: 1, completed: 2 }, ...(role === "assistant" ? { parentID: id.replace(/_r$/, "") } : {}) },
  parts: parts.map((part) => ({ ...part, messageID: id, sessionID: "ses_1", text: "" })),
})

const page = (entries: ReturnType<typeof entry>[], olderCursor?: string) => ({ entries, ...(olderCursor ? { olderCursor } : {}) }) as unknown as TranscriptPage

const turn = (userId: string, partIds: readonly [string, string]) => [
  entry(userId, "user", [{ type: "text", id: partIds[0] }]),
  entry(`${userId}_r`, "assistant", [{ type: "text", id: partIds[1] }]),
]

const shell = (output: string, headerOnly?: true): TranscriptPart => ({
  id: "p2",
  sessionID: "ses_1",
  messageID: "msg_2_r",
  type: "tool",
  callID: "c2",
  tool: "bash",
  state: { status: "completed", input: { command: "ls" }, output, title: "ls", metadata: {}, time: { start: 1, end: 2 } },
  ...(headerOnly ? { headerOnly } : {}),
})

const withShell = (turnPage: TranscriptPage, part: TranscriptPart) =>
  ({ ...turnPage, entries: turnPage.entries.map((item) => (item.info.id === "msg_2_r" ? { ...item, parts: [part, ...item.parts] } : item)) }) as TranscriptPage

const latest = page(turn("msg_2", ["p1", "p3"]), "before-the-turn")
const olderPage = page(turn("msg_1", ["p0", "p9"]))
const outline = { turns: [{ id: "msg_1", createdAt: 1, preview: {} }, { id: "msg_2", createdAt: 1, preview: {} }], complete: true }

const firstRead = (transcript: TranscriptPage): SessionFirstRead => ({
  row: { ref, title: "Two turns", createdAt: 1, updatedAt: 2 },
  diff: [],
  outline,
  transcript,
  latestTurn: undefined,
})

function fakeServer(first: SessionFirstRead = firstRead(latest), pages: readonly TranscriptPage[] = [olderPage]) {
  const olderReads: string[] = []
  const reads = {
    first: Promise.resolve(first),
    status: Promise.resolve({ kind: "idle" }),
    backgroundWork: Promise.resolve({ agents: 0, shells: 0, other: 0 }),
    requests: Promise.resolve([]),
    todos: Promise.resolve([]),
    goal: Promise.resolve({ goal: undefined, actions: [], available: false }),
    subagents: Promise.resolve([]),
  } as unknown as SessionReads
  const server = {
    sessions: {
      read: () => reads,
      page: async (_ref: SessionRef, _shape: unknown, cursor: string) => {
        olderReads.push(cursor)
        return pages[olderReads.length - 1] ?? olderPage
      },
      part: async () => shell("a\nb"),
    },
  } as unknown as Server
  const deps = {
    list: { readRow: () => undefined, readStatus: () => undefined, readBackgroundWork: () => undefined },
    requests: { read: () => undefined, readFailed: () => undefined },
    pageShape: () => ({ rows: 40, cols: 100, reasoning: false, shell: false, edit: false }),
  } as unknown as TranscriptDeps
  return { server, deps, olderReads }
}

const idle = () => new Promise((resolve) => setTimeout(resolve, 5))

test("snapshot: a first read lands its row, outline and page in one update, and nothing more is read until the reader pages", async () => {
  const { server, deps, olderReads } = fakeServer()
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, ref, deps)
    const seen: string[] = []
    createEffect(
      on(
        () => [context.phase.state().kind, context.data.messages.length, context.outline().kind] as const,
        (state) => seen.push(state.join(" ")),
      ),
    )
    await readSnapshot(context)
    expect(seen, "the row, page and outline land together").toEqual(["loading 0 loading", "ready 2 ready"])
    expect(context.olderCursor()).toBe("before-the-turn")
    await idle()
    expect(olderReads, "an idle transcript reads nothing").toEqual([])

    await loadOlder(context)
    expect(olderReads).toEqual(["before-the-turn"])
    expect(context.data.messages.map((message) => message.id)).toEqual(["msg_1", "msg_1_r", "msg_2", "msg_2_r"])
    expect(context.olderCursor()).toBeUndefined()
    dispose()
  })
})

test("older: a page that lands is out of flight before it is announced, so a watcher of the landing can page again at once", async () => {
  const { server, deps, olderReads } = fakeServer(undefined, [page(turn("msg_1", ["p0", "p9"]), "before-msg-1"), page(turn("msg_0", ["p5", "p6"]))])
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
    expect(context.data.messages.map((message) => message.id)).toEqual(["msg_0", "msg_0_r", "msg_1", "msg_1_r", "msg_2", "msg_2_r"])
    expect(context.olderCursor()).toBeUndefined()
    dispose()
  })
})

test("snapshot: a reread that sends a tool as its header keeps the body the reader loaded", async () => {
  const withHeader = withShell(latest, shell("", true))
  const { server, deps } = fakeServer(firstRead(withHeader))
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, ref, deps)
    await readSnapshot(context)
    await loadPart(context, "msg_2_r", "p2")
    await readSnapshot(context)
    expect(context.data.parts["msg_2_r"]).toEqual([shell("a\nb"), withHeader.entries[1]!.parts[1]!])
    dispose()
  })
})

test("snapshot: a reread's newer whole part replaces the body the reader loaded", async () => {
  const reads = [withShell(latest, shell("", true)), withShell(latest, shell("a\nb\nc"))]
  const { server: base, deps } = fakeServer()
  const server = { ...base, sessions: { ...base.sessions, read: () => ({ ...base.sessions.read(ref, deps.pageShape()), first: Promise.resolve(firstRead(reads.shift()!)) }) } } as unknown as Server
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, ref, deps)
    await readSnapshot(context)
    await loadPart(context, "msg_2_r", "p2")
    await readSnapshot(context)
    expect(context.data.parts["msg_2_r"]?.[0]).toEqual(shell("a\nb\nc"))
    dispose()
  })
})

test("older: a page that overlaps a turn whose tool body the reader loaded keeps the body", async () => {
  const withHeader = withShell(latest, shell("", true))
  const overlapping = page([...(olderPage.entries as ReturnType<typeof entry>[]), ...(withHeader.entries as ReturnType<typeof entry>[])])
  const { server, deps } = fakeServer(firstRead(withHeader), [overlapping])
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, ref, deps)
    await readSnapshot(context)
    await loadPart(context, "msg_2_r", "p2")
    await loadOlder(context)
    expect(context.data.messages.map((message) => message.id)).toEqual(["msg_1", "msg_1_r", "msg_2", "msg_2_r"])
    expect(context.data.parts["msg_2_r"]?.[0]).toEqual(shell("a\nb"))
    dispose()
  })
})

test("older: a refused page keeps the older cursor, so the reader can page again", async () => {
  const { server: base, deps } = fakeServer()
  const refused = new ServerError({ class: "network", message: "An older page cannot be read while the session's machine is offline" })
  const server = { ...base, sessions: { ...base.sessions, page: async () => Promise.reject(refused) } } as unknown as Server
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, ref, deps)
    await readSnapshot(context)
    await loadOlder(context)
    expect(context.older.state()).toMatchObject({ kind: "failed", error: { class: "network" } })
    expect(context.olderCursor()).toBe("before-the-turn")
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
