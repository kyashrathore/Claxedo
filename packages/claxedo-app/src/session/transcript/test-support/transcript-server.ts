import { placementId, projectId, sessionId, type Server, type SessionFirstRead, type SessionReads, type SessionLocation, type TranscriptPage, type TranscriptPart } from "@/server"
import type { TranscriptDeps } from "../context"

export const transcriptRef: SessionLocation = { projectId: projectId("project-1"), placementId: placementId("placement-1"), sessionId: sessionId("ses_1") }

export const entry = (id: string, role: "user" | "assistant", parts: readonly { readonly type: string; readonly id: string }[]) => ({
  info: { id, role, sessionID: "ses_1", time: { created: 1, completed: 2 }, ...(role === "assistant" ? { parentID: id.replace(/_r$/, "") } : {}) },
  parts: parts.map((part) => ({ ...part, messageID: id, sessionID: "ses_1", text: "" })),
})

export const page = (entries: ReturnType<typeof entry>[], olderCursor?: string) => ({ entries, ...(olderCursor ? { olderCursor } : {}) }) as unknown as TranscriptPage

export const turn = (userId: string, partIds: readonly [string, string]) => [
  entry(userId, "user", [{ type: "text", id: partIds[0] }]),
  entry(`${userId}_r`, "assistant", [{ type: "text", id: partIds[1] }]),
]

export const shell = (output: string, headerOnly?: true): TranscriptPart => ({
  id: "p2",
  sessionID: "ses_1",
  messageID: "msg_2_r",
  type: "tool",
  callID: "c2",
  tool: "bash",
  state: { status: "completed", input: { command: "ls" }, output, title: "ls", metadata: {}, time: { start: 1, end: 2 } },
  ...(headerOnly ? { headerOnly } : {}),
})

export const withShell = (turnPage: TranscriptPage, part: TranscriptPart) =>
  ({ ...turnPage, entries: turnPage.entries.map((item) => (item.info.id === "msg_2_r" ? { ...item, parts: [part, ...item.parts] } : item)) }) as TranscriptPage

export const latest = page(turn("msg_2", ["p1", "p3"]), "before-the-turn")
export const olderPage = page(turn("msg_1", ["p0", "p9"]))
const outline = { turns: [{ id: "msg_1", createdAt: 1, preview: {} }, { id: "msg_2", createdAt: 1, preview: {} }], complete: true }

export const firstReadOf = (transcript: TranscriptPage): SessionFirstRead => ({
  row: { ref: transcriptRef, title: "Two turns", createdAt: 1, updatedAt: 2 },
  diff: [],
  outline,
  transcript,
  latestTurn: undefined,
})

export function transcriptServer(first: SessionFirstRead = firstReadOf(latest), pages: readonly TranscriptPage[] = [olderPage]) {
  const olderReads: string[] = []
  const reads = {
    firstSent: Promise.resolve(undefined),
    first: Promise.resolve(first),
    runtime: Promise.resolve(undefined),
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
      page: async (_ref: SessionLocation, _shape: unknown, cursor: string) => {
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

export const idle = () => new Promise((resolve) => setTimeout(resolve, 5))
