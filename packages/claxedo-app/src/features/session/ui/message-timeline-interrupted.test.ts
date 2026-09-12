import { describe, expect, test } from "bun:test"
import { Timeline } from "./message-timeline.data"
import { TimelineRow } from "./timeline-row-model"
import type {
  AgentAssistantMessage as AssistantMessage,
  AgentContentPart as Part,
  AgentUserMessage as UserMessage,
} from "@claxedo/agent-runtime-contract"

function assistantMessage(overrides: Record<string, unknown> = {}): AssistantMessage {
  return {
    id: "a1",
    sessionID: "ses_test",
    role: "assistant",
    time: { created: 1_000 },
    ...overrides,
  } as AssistantMessage
}

describe("Timeline.turnInterrupted", () => {
  test("native harness abort: MessageAbortedError on any message wins", () => {
    const messages = [
      assistantMessage({ id: "a1", error: { name: "MessageAbortedError" }, time: { created: 1_000 } }),
      assistantMessage({ id: "a2", time: { created: 2_000, completed: 3_000 } }),
    ]
    expect(Timeline.turnInterrupted(messages)).toBe(true)
  })

  test("SDK harness abort: canonical cancelled outcome matches the assistant message", () => {
    const messages = [assistantMessage()]
    expect(Timeline.turnInterrupted(messages, {
      status: "cancelled",
      completedAt: 2_000,
      assistantMessageId: "a1",
    })).toBe(true)
  })

  test("an unsettled message is not interruption evidence", () => {
    const messages = [assistantMessage()]
    expect(Timeline.turnInterrupted(messages)).toBe(false)
    expect(Timeline.turnInterrupted(messages, {
      status: "completed",
      completedAt: 2_000,
      assistantMessageId: "a1",
    })).toBe(false)
  })

  test("a cancelled outcome for another turn does not mark this message interrupted", () => {
    const messages = [assistantMessage()]
    expect(Timeline.turnInterrupted(messages, {
      status: "cancelled",
      completedAt: 2_000,
      assistantMessageId: "a2",
    })).toBe(false)
  })

  test("a settled turn is not interrupted", () => {
    expect(Timeline.turnInterrupted([assistantMessage({ time: { created: 1_000, completed: 2_000 } })])).toBe(
      false,
    )
  })

  test("Pi-style failures (error + completed stamped) fall through to the error path, not interrupted", () => {
    const messages = [
      assistantMessage({ error: { name: "UnknownError" }, time: { created: 1_000, completed: 2_000 } }),
    ]
    expect(Timeline.turnInterrupted(messages)).toBe(false)
  })

  test("a turn with no assistant messages is not interrupted", () => {
    expect(Timeline.turnInterrupted([], {
      status: "cancelled",
      completedAt: 2_000,
      assistantMessageId: "a1",
    })).toBe(false)
  })
})

describe("the fold row of an interrupted turn", () => {
  function toolPart(id: string, messageID: string, tool: string): Part {
    return {
      id,
      sessionID: "ses_test",
      messageID,
      type: "tool",
      tool,
      callID: `${id}_c`,
      state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } },
    } as Part
  }

  // One run of shell calls each side of the interruption: whole, they are one work
  // group; split at the interruption, they are the two the timeline draws.
  function interruptedTurnRows() {
    const user: UserMessage = { id: "u1", sessionID: "ses_test", role: "user", time: { created: 1_000 } }
    const aborted = assistantMessage({ id: "a1", error: { name: "MessageAbortedError" } })
    const resumed = assistantMessage({ id: "a2", time: { created: 2_000, completed: 3_000 } })
    const byMessage: Record<string, Part[]> = {
      u1: [],
      a1: [toolPart("p1", "a1", "bash"), toolPart("p2", "a1", "bash")],
      a2: [toolPart("p3", "a2", "bash"), toolPart("p4", "a2", "bash")],
    }
    return Timeline.constructMessageRows(
      user,
      (messageID) => byMessage[messageID] ?? [],
      [aborted, resumed],
      0,
      false,
      "idle",
      false,
      false,
    )
  }

  test("counts the groups either side of the interruption, not one run across it", () => {
    const rows = interruptedTurnRows()
    const fold = rows.find((row): row is TimelineRow.TurnFold => row._tag === "TurnFold")
    const groups = rows.filter((row): row is TimelineRow.AssistantPart => row._tag === "AssistantPart")
    expect(groups.map((row) => row.group.type)).toEqual(["work", "work"])
    expect(fold?.foldCount).toBe(groups.length)
  })

  test("an interrupted turn keeps its rows up under the control", () => {
    const rows = interruptedTurnRows()
    const fold = rows.find((row): row is TimelineRow.TurnFold => row._tag === "TurnFold")
    expect(fold?.folded).toBe(false)
    expect(rows.some((row) => row._tag === "TurnDivider" && row.label === "interrupted")).toBe(true)
  })
})
