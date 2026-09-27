import { AgentMessagePageError } from "@claxedo/agent-sdk-runtime/message-page"
import { projectTurn, type TurnPageQuery } from "@claxedo/agent-sdk-runtime/turn-page"
import type { AgentMessage } from "@claxedo/agent-runtime-contract"
import { registerTranscriptSession, syncTranscript, syncedMessage, type TranscriptConformanceHarness } from "./stored-transcript.conformance"

type LatestTurn = { messages: AgentMessage[]; nextCursor?: string }

const sessionId = "ses_turn_page"
const toolOutput = "x".repeat(4096)
const message = syncedMessage.bind(undefined, sessionId)

const readTool = (callID: string, at: number) => ({
  type: "tool",
  tool: "read",
  callID,
  state: { status: "completed", input: { filePath: "a.ts" }, output: toolOutput, title: "a.ts", metadata: {}, time: { start: at, end: at + 1 } },
})

/**
 * A registry's page of the turns before a cursor its own latest-turn view
 * issued: each whole turn, oldest first, projected by the contract (folded
 * when the fold decision folds it, its tools as headers), with a cursor on
 * every turn that has older history. A cursor at the transcript's oldest turn
 * reads an empty page, a cursor the registry did not issue is refused as a 400
 * message-page error, and a session the registry does not hold has no page.
 */
export async function exerciseTurnPageConformance(harness: TranscriptConformanceHarness) {
  const { authority, workspaceId, creator } = harness
  await registerTranscriptSession(harness, sessionId)
  await syncTranscript(harness, sessionId, [
    message("a0", "assistant", [{ type: "text", text: "Hello." }]),
    message("u1", "user", [{ type: "text", text: "first" }]),
    message("a1", "assistant", [readTool("call-1", 11), { type: "text", text: "first answer" }], { parentID: "u1" }),
    message("u2", "user", [{ type: "text", text: "second" }]),
    message("a2-work", "assistant", [{ type: "text", text: "Looking." }, readTool("call-2", 21)], { parentID: "u2" }),
    message("a2", "assistant", [{ type: "reasoning", text: "thinking" }, { type: "text", text: "second answer" }], { parentID: "u2" }),
    message("u3", "user", [{ type: "text", text: "third" }]),
    message("a3", "assistant", [{ type: "text", text: "third answer" }], { parentID: "u3" }),
  ])

  const latestTurn = async (before?: string) =>
    (await authority.readSessionMessages(creator.auth, { sessionId, workspaceId, view: "latest-turn", ...(before ? { before } : {}) })) as LatestTurn
  const third = await latestTurn()
  const second = await latestTurn(third.nextCursor)
  const first = await latestTurn(second.nextCursor)
  turnPageHolds(third.nextCursor && second.nextCursor && first.nextCursor, "every turn after the leading greeting did not carry a cursor before it")

  const query: TurnPageQuery = { rows: 40, cols: 100, reasoning: false, shell: false, edit: false }
  const read = async (id: string, before: string) => await authority.readSessionPage(creator.auth, { sessionId: id, workspaceId, page: { ...query, before } })

  const page = await read(sessionId, third.nextCursor)
  turnPageHolds(page, "a session the reader can read answered no page")
  turnPageHolds(
    JSON.stringify(page) === JSON.stringify({
      turns: [
        { ...projectTurn(first.messages, query), cursor: first.nextCursor },
        { ...projectTurn(second.messages, query), cursor: second.nextCursor },
      ],
    }),
    "the page is not the two turns before the cursor, projected, each with its own cursor",
  )
  turnPageHolds(page.turns[1]?.foldableCount === 2, "the folded turn before the cursor did not name its two foldable groups")
  turnPageHolds(!JSON.stringify(page).includes(toolOutput), "a tool the reader's settings leave closed was sent whole")

  turnPageHolds(JSON.stringify(await read(sessionId, first.nextCursor)) === JSON.stringify({ turns: [] }), "a cursor at the oldest turn did not read an empty page")
  turnPageHolds((await read("ses_turn_page_missing", third.nextCursor)) === undefined, "a session the registry does not hold answered a page")
  const refused = await read(sessionId, "not-a-cursor").then(() => undefined, (error: unknown) => error)
  turnPageHolds(refused instanceof AgentMessagePageError && refused.status === 400, "a cursor the registry did not issue was not refused as a 400 message-page error")
  return page.turns.map((turn) => turn.messages[0]?.info.id)
}

function turnPageHolds(condition: unknown, text: string): asserts condition {
  if (!condition) throw new Error(`Turn-page conformance failed: ${text}`)
}
