import type { TurnPageRequest, FirstRead } from "@claxedo/agent-sdk-runtime/turn-page"
import type { PrivateSessionInventoryRow } from "./private-session-authority"
import { registerTranscriptSession, syncTranscript, syncedMessage, type TranscriptConformanceHarness } from "./stored-transcript.conformance"

type Page = { messages: Array<{ info: { id: string }; parts: Array<{ type: string }> }>; nextCursor?: string }

const sessionId = "ses_first_read"
const message = syncedMessage.bind(undefined, sessionId)

/**
 * A registry's first read of a session it stores: the row exactly as its
 * inventory lists it; the outline of every turn of the window, oldest first,
 * with the prompt cut to a snippet; and, when the read names a viewport, the
 * first page, read one whole turn at a time from the newest, each turn folded
 * when the contract's fold decision folds it, with a cursor on every turn that
 * has older history. A session with no transcript reads as complete and empty
 * with an empty page; a session the registry does not hold has no first read.
 */
export async function exerciseFirstReadConformance(harness: TranscriptConformanceHarness) {
  const { authority, workspaceId, creator } = harness
  await registerTranscriptSession(harness, sessionId)
  const viewport: TurnPageRequest = { rows: 40, cols: 100, reasoning: false, shell: false, edit: false }
  const read = async (firstPage?: TurnPageRequest) =>
    await authority.readSessionFirstRead(creator.auth, { sessionId, workspaceId, ...(firstPage ? { firstPage } : {}) })
  const listed = async () => (await authority.listSessions(creator.auth, { workspaceId })).find((row) => row.session_id === sessionId)

  const empty = await read(viewport)
  firstReadHolds(
    JSON.stringify(empty) === JSON.stringify({ session: await listed(), outline: { turns: [], complete: true }, page: { turns: [] } }),
    "an empty transcript did not read as its listed row, a complete empty outline and an empty page",
  )
  firstReadHolds(
    (await authority.readSessionFirstRead(creator.auth, { sessionId: "ses_first_read_missing", workspaceId })) === undefined,
    "a session the registry does not hold answered a first read",
  )

  await syncTranscript(harness, sessionId, [
    message("u1", "user", [{ type: "text", text: "  first\n\nprompt " }], { summary: { title: "First" } }),
    message("a1", "assistant", [{ type: "text", text: "first answer, at length past the snippet" }], { parentID: "u1" }),
    message("u2", "user", [{ type: "text", text: "second" }]),
    message("a2-work", "assistant", [
      { type: "text", text: "Looking." },
      { type: "tool", tool: "read", callID: "call-read", state: { status: "completed", input: {}, output: "x".repeat(2048), title: "read", metadata: {}, time: { start: 21, end: 22 } } },
    ], { parentID: "u2" }),
    message("a2", "assistant", [{ type: "reasoning", text: "thinking" }, { type: "text", text: "second answer" }], { parentID: "u2" }),
  ])

  const outlineOnly = await read()
  firstReadHolds(outlineOnly !== undefined && !("page" in outlineOnly), "a read without a viewport answered a page")
  firstReadHolds(JSON.stringify(outlineOnly.session) === JSON.stringify(await listed()), "the first read's row is not the row the inventory lists")
  firstReadHolds(outlineOnly.outline.complete, "a whole transcript did not outline as complete")
  firstReadHolds(
    JSON.stringify(outlineOnly.outline.turns) === JSON.stringify([
      { id: "u1", createdAt: 10, title: "First", user: "first prompt" },
      { id: "u2", createdAt: 20, user: "second" },
    ]),
    "the turns' titles, times or prompt snippets are wrong",
  )

  const latest = (await authority.readSessionMessages(creator.auth, { sessionId, workspaceId, view: "latest-turn" })) as Page
  const earlier = (await authority.readSessionMessages(creator.auth, { sessionId, workspaceId, view: "latest-turn", before: latest.nextCursor })) as Page
  const [prompt, work, answer] = latest.messages
  firstReadHolds(prompt && work && answer && latest.nextCursor, "the latest turn is not the prompt, the work and the answer with a cursor before it")
  const first = (await read(viewport)) as FirstRead<PrivateSessionInventoryRow>
  firstReadHolds(
    JSON.stringify(first.page?.turns) === JSON.stringify([
      { messages: earlier.messages },
      {
        messages: [prompt, { ...work, parts: [] }, { ...answer, parts: answer.parts.filter((part) => part.type === "text") }],
        foldableCount: 2,
        cursor: latest.nextCursor,
      },
    ]),
    "the page is not the first turn whole and the latest turn folded to its answer, with the latest turn's cursor",
  )
  return { outline: first.outline.turns.map((turn) => turn.id), foldableCounts: first.page?.turns.map((turn) => turn.foldableCount ?? 0) }
}

function firstReadHolds(condition: unknown, text: string): asserts condition {
  if (!condition) throw new Error(`First-read conformance failed: ${text}`)
}
