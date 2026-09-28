import { AgentMessagePageError } from "@claxedo/agent-sdk-runtime/message-page"
import { projectTurn, type PageTurn, type ReaderSettings, type TurnPage, type TurnPageRequest } from "@claxedo/agent-sdk-runtime/turn-page"
import type { AgentMessage, AgentToolPart } from "@claxedo/agent-runtime-contract"
import { registerTranscriptSession, syncTranscript, syncedMessage, type SyncedMessage, type TranscriptConformanceHarness } from "./stored-transcript.conformance"

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
 * issued: each whole turn, oldest first, projected by the contract (every
 * part, its tools as headers), with a cursor on every turn that has older
 * history. A cursor at the transcript's oldest turn reads an empty page, a
 * cursor the registry did not issue is refused as a 400 message-page error,
 * and a session the registry does not hold has no page. Every read passes the
 * tool-header reads (`exerciseToolHeaderReads`).
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

  const settings: ReaderSettings = { reasoning: false, shell: false, edit: false }
  const query: TurnPageRequest = { ...settings, rows: 40, cols: 100 }
  const read = async (id: string, before: string) =>
    await authority.readSessionPage(creator.auth, { sessionId: id, workspaceId, page: { ...query, before } })

  const page = await read(sessionId, third.nextCursor)
  turnPageHolds(page, "a session the reader can read answered no page")
  turnPageHolds(
    JSON.stringify(page) === JSON.stringify({
      turns: [
        { ...projectTurn(first.messages, settings), cursor: first.nextCursor },
        { ...projectTurn(second.messages, settings), cursor: second.nextCursor },
      ],
    }),
    "the page is not the two turns before the cursor, projected, each with its own cursor",
  )
  turnPageHolds(!JSON.stringify(page).includes(toolOutput), "a tool the reader's settings leave closed was sent whole")

  turnPageHolds(JSON.stringify(await read(sessionId, first.nextCursor)) === JSON.stringify({ turns: [] }), "a cursor at the oldest turn did not read an empty page")
  turnPageHolds((await read("ses_turn_page_missing", third.nextCursor)) === undefined, "a session the registry does not hold answered a page")
  const refused = await read(sessionId, "not-a-cursor").then(() => undefined, (error: unknown) => error)
  turnPageHolds(refused instanceof AgentMessagePageError && refused.status === 400, "a cursor the registry did not issue was not refused as a 400 message-page error")

  const headerSession = "ses_turn_page_tool_headers"
  const transcript = toolHeaderTranscript(headerSession)
  await registerTranscriptSession(harness, headerSession)
  await syncTranscript(harness, headerSession, transcript)
  const at = { sessionId: headerSession, workspaceId }
  const extent = { rows: 40, cols: 100 }
  await exerciseToolHeaderReads({
    first: async (reader) => (await authority.readSessionFirstRead(creator.auth, { ...at, firstPage: { ...reader, ...extent } }))?.page,
    page: async (reader, before) => await authority.readSessionPage(creator.auth, { ...at, page: { ...reader, ...extent, before } }),
  }, transcript)
  return page.turns.map((turn) => turn.messages[0]?.info.id)
}

const TOOL_OUTPUT_BYTES = 64 * 1024

/** A tool body named so that a read which leaks it names the leak: `<tool>-<field>:` then filler. */
const toolBody = (name: string, bytes = 1024) => `${name}:${"x".repeat(bytes)}`

const TOOL_BODIES = ["read-output", "read-preview", "read-attachment", "bash-output", "bash-metadata", "edit-old", "edit-new", "edit-output", "edit-before", "edit-after"]

const completedTool = (messageId: string, tool: string, input: Record<string, unknown>, metadata: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "tool",
  tool,
  callID: `call-${tool}-${messageId}`,
  state: { status: "completed", input, output: toolBody(`${tool}-output`, TOOL_OUTPUT_BYTES), title: tool, metadata, time: { start: 1, end: 2 }, ...extra },
})

function bodiedTools(sessionId: string, messageId: string) {
  return {
    read: completedTool(messageId, "read", { filePath: "shot.png" }, { loaded: ["shot.png"], preview: toolBody("read-preview") }, {
      attachments: [{ id: `${messageId}-attachment`, sessionID: sessionId, messageID: messageId, type: "file", mime: "image/png", url: `data:image/png;base64,${toolBody("read-attachment")}` }],
    }),
    bash: completedTool(messageId, "bash", { command: "ls" }, { command: "ls", exitCode: 0, output: toolBody("bash-metadata") }),
    edit: completedTool(messageId, "edit", { filePath: "a.ts", oldString: toolBody("edit-old"), newString: toolBody("edit-new") }, {
      filediff: { file: "a.ts", additions: 1, deletions: 1, before: toolBody("edit-before"), after: toolBody("edit-after") },
      diagnostics: {},
    }),
  }
}

/**
 * Four turns whose tools carry 64 KiB outputs, body metadata and, for the
 * read, an attachment: a shell, an edit and a read turn that no fold folds,
 * and a newest turn that folds all three behind its answer.
 */
export function toolHeaderTranscript(sessionId: string): SyncedMessage[] {
  const message = syncedMessage.bind(undefined, sessionId)
  const tools = (messageId: string) => bodiedTools(sessionId, messageId)
  return [
    message("u1", "user", [{ type: "text", text: "list" }]),
    message("a1", "assistant", [tools("a1").bash, { type: "text", text: "Listed." }], { parentID: "u1" }),
    message("u2", "user", [{ type: "text", text: "edit" }]),
    message("a2", "assistant", [tools("a2").edit, { type: "text", text: "Edited." }], { parentID: "u2" }),
    message("u3", "user", [{ type: "text", text: "look" }]),
    message("a3", "assistant", [tools("a3").read, { type: "text", text: "Looked." }], { parentID: "u3" }),
    message("u4", "user", [{ type: "text", text: "all" }]),
    message("a4-work", "assistant", [{ type: "text", text: "Looking." }, ...Object.values(tools("a4-work"))], { parentID: "u4" }),
    message("a4", "assistant", [{ type: "text", text: "Done." }], { parentID: "u4" }),
  ]
}

/** A producer's first read's page and page read of the session holding `toolHeaderTranscript`, each with the reader's settings. */
export type ToolHeaderReads = {
  first: (reader: ReaderSettings) => Promise<TurnPage | undefined>
  page: (reader: ReaderSettings, before: string) => Promise<TurnPage | undefined>
}

/**
 * Every read sends each tool part as its header: marked `headerOnly`, with no
 * output, body input, body metadata or attachments. A tool the reader's shell or edit setting opens comes whole
 * instead, and every turn carries every part it stores. Checked with the shell
 * and edit settings both closed and both open.
 */
export async function exerciseToolHeaderReads(reads: ToolHeaderReads, transcript: readonly SyncedMessage[]) {
  const stored = new Map(transcript.map((message) => [message.info.id, message.parts.map((part) => part.id)]))
  const sentAsHeaders = (label: string, turns: readonly PageTurn[], reader: ReaderSettings) => {
    const tools = turns.flatMap((turn) => {
      const sent = turn.messages.map((message) => message.parts.map((part) => part.id))
      turnPageHolds(
        JSON.stringify(sent) === JSON.stringify(turn.messages.map((message) => stored.get(message.info.id))),
        `${label} sent a turn without every part it stores`,
      )
      return turn.messages.flatMap((message) => message.parts.filter((part): part is AgentToolPart => part.type === "tool"))
    })
    turnPageHolds(["read", "bash", "edit"].every((name) => tools.some((part) => part.tool === name)), `${label} sent no read, shell and edit tool to check`)
    for (const part of tools) {
      const sent = JSON.stringify(part)
      if ((part.tool === "bash" && reader.shell) || (part.tool === "edit" && reader.edit)) {
        turnPageHolds(
          part.headerOnly === undefined && TOOL_BODIES.filter((name) => name.startsWith(`${part.tool}-`)).every((name) => sent.includes(`${name}:`)),
          `${label} did not send the ${part.tool} tool the reader's settings open whole`,
        )
      } else {
        turnPageHolds(
          part.headerOnly === true
            && part.state.status === "completed"
            && part.state.output === ""
            && part.state.attachments === undefined
            && TOOL_BODIES.every((name) => !sent.includes(`${name}:`)),
          `${label} did not send the ${part.tool} tool as its header, without its output, body input, body metadata or attachments`,
        )
      }
    }
  }

  for (const reader of [{ reasoning: false, shell: false, edit: false }, { reasoning: false, shell: true, edit: true }]) {
    const settings = `shell ${reader.shell ? "open" : "closed"}, edit ${reader.edit ? "open" : "closed"}`
    const first = await reads.first(reader)
    const latest = first?.turns.at(-1)
    turnPageHolds(first?.turns.length === 4 && latest?.cursor, `the first read (${settings}) did not send all four turns with the latest turn's cursor`)
    sentAsHeaders(`the first read (${settings})`, first.turns, reader)
    const page = await reads.page(reader, latest.cursor)
    turnPageHolds(page?.turns.length === 3, `the page read (${settings}) did not send the three turns before the latest`)
    sentAsHeaders(`the page read (${settings})`, page.turns, reader)
  }
}

function turnPageHolds(condition: unknown, text: string): asserts condition {
  if (!condition) throw new Error(`Turn-page conformance failed: ${text}`)
}
