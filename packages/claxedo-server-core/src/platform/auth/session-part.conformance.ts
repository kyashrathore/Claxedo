import { registerTranscriptSession, storedMessagePage, syncTranscript, syncedMessage, type TranscriptConformanceHarness } from "./stored-transcript.conformance"

const sessionId = "ses_session_part"
const toolOutput = "x".repeat(4096)
const message = syncedMessage.bind(undefined, sessionId)

/**
 * A registry's answer for one part of one stored message: the part whole as
 * the runtime synced it, however a page sent it. The part a page sent as its
 * header reads back with its output; a part id the message does not hold, or
 * one another message holds, reads as no part; a session the registry does
 * not hold has no answer at all.
 */
export async function exerciseSessionPartConformance(harness: TranscriptConformanceHarness) {
  const { authority, workspaceId, creator } = harness
  await registerTranscriptSession(harness, sessionId)
  await syncTranscript(harness, sessionId, [
    message("u1", "user", [{ type: "text", text: "read it" }]),
    message("a1", "assistant", [
      { type: "tool", tool: "read", callID: "call-1", state: { status: "completed", input: { filePath: "a.ts" }, output: toolOutput, title: "a.ts", metadata: {}, time: { start: 11, end: 12 } } },
      { type: "text", text: "Read." },
    ], { parentID: "u1" }),
  ])
  const read = async (messageId: string, partId: string, id = sessionId) =>
    await authority.readSessionPart(creator.auth, { sessionId: id, workspaceId, messageId, partId })

  const first = await authority.readSessionFirstRead(creator.auth, {
    sessionId,
    workspaceId,
    firstPage: { rows: 40, cols: 100, reasoning: false, shell: false, edit: false },
  })
  const header = first?.page?.turns[0]?.messages[1]?.parts[0]
  sessionPartHolds(header?.type === "tool" && header.headerOnly === true, "the page did not send the tool as its header")

  const stored = storedMessagePage(await authority.readSessionMessages(creator.auth, { sessionId, workspaceId, view: "latest-turn" }))
  const whole = stored.messages[1]?.parts[0]
  sessionPartHolds(whole?.type === "tool" && whole.state.status === "completed" && whole.state.output === toolOutput, "the stored tool part is not whole")
  sessionPartHolds(JSON.stringify(await read("a1", header.id)) === JSON.stringify({ part: whole }), "the part a page sent as its header did not read back whole")

  sessionPartHolds(JSON.stringify(await read("a1", "a1-p9")) === "{}", "a part the message does not hold answered a part")
  sessionPartHolds(JSON.stringify(await read("u1", header.id)) === "{}", "a part another message holds answered through the wrong message")
  sessionPartHolds(JSON.stringify(await read("a9", "a9-p0")) === "{}", "a message the session does not hold answered a part")
  sessionPartHolds((await read("a1", header.id, "ses_session_part_missing")) === undefined, "a session the registry does not hold answered a part")
  return header.id
}

function sessionPartHolds(condition: unknown, text: string): asserts condition {
  if (!condition) throw new Error(`Session-part conformance failed: ${text}`)
}
