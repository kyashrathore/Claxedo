import { describe, expect, test } from "bun:test"
import { Timeline } from "./message-timeline.data"
import { TimelineRow } from "./timeline-row-model"
import type { AgentAssistantMessage as AssistantMessage, AgentContentPart as Part, AgentUserMessage as UserMessage } from "@claxedo/agent-runtime-contract"

/**
 * The timeline groups tool runs by tool NAME, and Claxedo drives more than one harness:
 * OpenCode emits `bash`/`edit`, Codex emits `command`/`edit_file`. A run of Codex shell
 * calls once rendered as N loud ungrouped "Called `command`" rows because only OpenCode's
 * vocabulary was known. These tests pin both vocabularies.
 */
const SESSION = "ses_test"

// The contract's message/part types carry far more than the grouping pass reads,
// so each fixture below builds the minimal shape it actually consumes and narrows
// at its own return.

function userMessage(id: string): UserMessage {
  return { id, sessionID: SESSION, role: "user", time: { created: 1_000 } }
}

function assistantMessage(id: string): AssistantMessage {
  return {
    id,
    sessionID: SESSION,
    role: "assistant",
    time: { created: 1_000, completed: 61_000 },
  } as AssistantMessage
}

function toolPart(id: string, messageID: string, tool: string): Part {
  return {
    id,
    sessionID: SESSION,
    messageID,
    type: "tool",
    tool,
    callID: `${id}_c`,
    state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } },
  } as Part
}

function textPart(id: string, messageID: string, text: string): Part {
  return { id, sessionID: SESSION, messageID, type: "text", text } as Part
}

function rowsFor(parts: Part[]) {
  const user = userMessage("u1")
  const assistant = assistantMessage("a1")
  const byMessage: Record<string, Part[]> = { u1: [], a1: parts }
  return Timeline.constructMessageRows(
    user,
    (messageID) => byMessage[messageID] ?? [],
    [assistant],
    0,
    false,
    "idle",
    false,
    false,
    // keep turns unfolded so the group rows are directly observable
    () => false,
  )
}

function groupTypes(rows: TimelineRow.TimelineRow[]) {
  return rows.filter((row): row is TimelineRow.AssistantPart => row._tag === "AssistantPart").map((row) => row.group.type)
}

describe("timeline grouping across harness vocabularies", () => {
  test("cold final turns retain subagent cards from intermediate assistant messages", () => {
    const toolMessage = assistantMessage("assistant-tool")
    const finalMessage = assistantMessage("assistant-final")
    const byMessage: Record<string, Part[]> = {
      "assistant-tool": [toolPart("task-part", "assistant-tool", "task")],
      "assistant-final": [textPart("text-part", "assistant-final", "done")],
    }

    expect([
      ...Timeline.coldFinalVisibleAssistantMessageIDs(
        [toolMessage, finalMessage],
        (messageID) => byMessage[messageID] ?? [],
      )!,
    ]).toEqual(["assistant-final", "assistant-tool"])
  })

  for (const shell of ["bash", "command", "shell", "local_shell"]) {
    test(`folds a run of consecutive \`${shell}\` calls into one work group`, () => {
      const rows = rowsFor([
        toolPart("p1", "a1", shell),
        toolPart("p2", "a1", shell),
        toolPart("p3", "a1", shell),
      ])
      expect(groupTypes(rows)).toEqual(["work"])
    })
  }

  test("a lone shell call stays a standalone row", () => {
    const rows = rowsFor([toolPart("p1", "a1", "command")])
    expect(groupTypes(rows)).toEqual(["part"])
    expect(rows.some((row) => row._tag === "TurnFold")).toBe(false)
  })

  test("a lone subagent task is a one-chip agents row, not a second card shape", () => {
    const rows = rowsFor([toolPart("p1", "a1", "task")])
    expect(groupTypes(rows)).toEqual(["agents"])
    expect(rows.some((row) => row._tag === "TurnFold")).toBe(false)
  })

  test("prose between runs splits them into separate groups", () => {
    const rows = rowsFor([
      toolPart("p1", "a1", "command"),
      toolPart("p2", "a1", "command"),
      textPart("p3", "a1", "Review scope: local working tree changes"),
      toolPart("p4", "a1", "command"),
      toolPart("p5", "a1", "command"),
    ])
    expect(groupTypes(rows)).toEqual(["work", "part", "work"])
  })

  test("Codex edit/read names group like their OpenCode equivalents", () => {
    expect(groupTypes(rowsFor([toolPart("p1", "a1", "edit_file"), toolPart("p2", "a1", "write_file")]))).toEqual(["work"])
    expect(groupTypes(rowsFor([toolPart("p1", "a1", "read_file"), toolPart("p2", "a1", "read_file")]))).toEqual([
      "context",
    ])
  })

  test("consecutive subagent tasks fold into an agents chip row", () => {
    expect(groupTypes(rowsFor([toolPart("p1", "a1", "task"), toolPart("p2", "a1", "task")]))).toEqual(["agents"])
  })
})

describe("turn fold placement", () => {
  // D§3.6 / Codex: "Worked for Xs" + rule is the turn HEADER — it sits above the turn's
  // content, not wherever the first tool call happened to land.
  // Two foldable groups (the fold threshold is ≥2 foldable ROWS, and a consecutive run
  // collapses to a single group) separated by prose.
  const withProseThenTools = [
    textPart("p1", "a1", "I'll inspect the middleware."),
    toolPart("p2", "a1", "command"),
    toolPart("p3", "a1", "command"),
    textPart("p4", "a1", "Now applying the fix."),
    toolPart("p5", "a1", "edit_file"),
    toolPart("p6", "a1", "edit_file"),
    textPart("p7", "a1", "Fixed."),
  ]

  test("fold row is emitted before any assistant content", () => {
    const rows = rowsFor(withProseThenTools).filter(
      (row) => row._tag === "AssistantPart" || row._tag === "TurnFold",
    )
    expect(rows[0]?._tag).toBe("TurnFold")
  })

  test("folded turn hides the work rows and the narration between them, and keeps the answer", () => {
    const user = userMessage("u1")
    const rows = Timeline.constructMessageRows(
      user,
      (id) => (id === "a1" ? withProseThenTools : []),
      [assistantMessage("a1")],
      0,
      false,
      "idle",
      false,
      false,
      () => true, // explicitly folded
    )
    expect(groupTypes(rows)).toEqual(["part"])
    expect(rows.flatMap((row) => (row._tag === "AssistantPart" && row.group.type === "part" ? [row.group.ref.partID] : []))).toEqual(["p7"])
    expect(rows.some((row) => row._tag === "TurnFold")).toBe(true)
  })

  // The assistant message here is completed: a multi-step turn reads settled from
  // its first step on, so the session's status is what says the turn is still going.
  const activeTurn = (
    status: Parameters<typeof Timeline.constructMessageRows>[5],
    options: { settlePending?: boolean; choice?: boolean } = {},
  ) =>
    Timeline.constructMessageRows(
      userMessage("u1"),
      (id) => (id === "a1" ? withProseThenTools : []),
      [assistantMessage("a1")],
      0,
      false,
      status,
      true,
      false,
      () => options.choice,
      undefined,
      undefined,
      undefined,
      undefined,
      options.settlePending ?? false,
    )

  test("a turn the session is still working on shows every row and no fold control", () => {
    for (const rows of [activeTurn("busy"), activeTurn("retry"), activeTurn("idle", { settlePending: true })]) {
      expect(rows.some((row) => row._tag === "TurnFold")).toBe(false)
      expect(groupTypes(rows)).toEqual(["part", "work", "part", "work", "part"])
    }
  })

  test("a remembered fold choice does not fold a turn that is still working", () => {
    const rows = activeTurn("busy", { choice: true })
    expect(rows.some((row) => row._tag === "TurnFold")).toBe(false)
    expect(groupTypes(rows)).toEqual(["part", "work", "part", "work", "part"])
  })

  test("the same turn folds once the session goes idle on it", () => {
    const rows = activeTurn("idle")
    const fold = rows.find((row): row is TimelineRow.TurnFold => row._tag === "TurnFold")
    expect(fold?.folded).toBe(true)
    expect(groupTypes(rows)).toEqual(["part"])
  })
})
