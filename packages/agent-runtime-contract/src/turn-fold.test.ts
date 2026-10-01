import { describe, expect, test } from "bun:test"
import type { AgentAssistantMessage, AgentContentPart, AgentToolPart } from "./content"
import {
  countFoldableGroups,
  foldedGroupKeys,
  groupParts,
  partHasText,
  turnFoldDecision,
  turnFoldShape,
  turnSegments,
  type FoldablePartLookup,
  type PartGroup,
} from "./turn-fold"

const base = { sessionID: "ses", messageID: "a1" }

function text(id: string, value: string, messageID = "a1"): AgentContentPart {
  return { ...base, messageID, id, type: "text", text: value }
}

function reasoning(id: string, value: string): AgentContentPart {
  return { ...base, id, type: "reasoning", text: value, time: { start: 1 } }
}

function tool(id: string, name: string, status: AgentToolPart["state"]["status"] = "completed", input: Record<string, unknown> = {}, messageID = "a1"): AgentToolPart {
  const state: AgentToolPart["state"] =
    status === "completed"
      ? { status, input, output: "", title: "", metadata: {}, time: { start: 1, end: 2 } }
      : status === "error"
        ? { status, input, error: "failed", time: { start: 1, end: 2 } }
        : status === "running"
          ? { status, input, time: { start: 1 } }
          : { status, input, raw: "" }
  return { ...base, messageID, id, type: "tool", callID: `call_${id}`, tool: name, state }
}

function assistant(id: string, extra: Partial<AgentAssistantMessage> = {}): AgentAssistantMessage {
  return {
    id,
    sessionID: "ses",
    role: "assistant",
    time: { created: 1, completed: 2 },
    parentID: "u1",
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...extra,
  }
}

const groupsOf = (parts: AgentContentPart[]) => groupParts(parts.map((part) => ({ messageId: part.messageID, part })))
const shapeOf = (groups: PartGroup[]) => groups.map((group) => group.type === "work" ? `work:${group.tool}` : group.type)
const lookup = (parts: AgentContentPart[], open: ReadonlySet<string> = new Set()): FoldablePartLookup => {
  const byId = new Map(parts.map((part) => [part.id, part] as const))
  return (ref) => {
    const part = byId.get(ref.partId)
    return part ? { type: part.type, userOpen: open.has(part.id) } : undefined
  }
}

describe("groupParts", () => {
  test("gathers reads into one context group, two or more work tools into a work group, and keeps a lone work tool a part", () => {
    const groups = groupsOf([
      tool("r1", "Read"),
      tool("r2", "grep"),
      text("t1", "found it"),
      tool("b1", "bash"),
      tool("e1", "edit"),
      text("t2", "done"),
      tool("b2", "bash"),
      text("t3", "answer"),
    ])
    expect(shapeOf(groups)).toEqual(["context", "part", "work:edit", "part", "part", "part"])
    expect(groups[0]).toEqual({ key: "context:r1", type: "context", refs: [{ messageId: "a1", partId: "r1" }, { messageId: "a1", partId: "r2" }] })
  })

  test("groups consecutive subagent spawns, but a failed spawn and a Claxedo tool stay parts of their own", () => {
    const groups = groupsOf([
      tool("s1", "Agent"),
      tool("s2", "task"),
      tool("s3", "Agent", "error"),
      tool("c1", "mcp__claxedo__sessions_list"),
      tool("c2", "mcp__claxedo__session_get"),
    ])
    expect(shapeOf(groups)).toEqual(["agents", "part", "part", "part"])
  })

  test("leaves an open question out of the groups", () => {
    expect(shapeOf(groupsOf([tool("q1", "question", "running"), text("t1", "waiting")]))).toEqual(["part"])
  })
})

describe("turnFoldDecision", () => {
  test("folds a settled turn with at least two foldable groups, and not a running one", () => {
    expect(turnFoldDecision({ foldableCount: 2, settled: true })).toEqual({ canFold: true, folded: true, explicit: false })
    expect(turnFoldDecision({ foldableCount: 1, settled: true })).toEqual({ canFold: false, folded: false, explicit: false })
    expect(turnFoldDecision({ foldableCount: 5, settled: true, busy: true })).toEqual({ canFold: false, folded: false, explicit: false })
  })

  test("offers the fold on an interrupted or failed turn but leaves it open, unless the reader chose", () => {
    expect(turnFoldDecision({ foldableCount: 3, settled: true, interrupted: true })).toEqual({ canFold: true, folded: false, explicit: false })
    expect(turnFoldDecision({ foldableCount: 3, settled: true, errored: true })).toEqual({ canFold: true, folded: false, explicit: false })
    expect(turnFoldDecision({ foldableCount: 3, settled: true, errored: true, userChoice: true })).toEqual({ canFold: true, folded: true, explicit: true })
    expect(turnFoldDecision({ foldableCount: 3, settled: true, errored: true, busy: true })).toEqual({ canFold: true, folded: false, explicit: false })
  })

  test("a turn with fewer foldable groups than the minimum never offers the fold, whoever asks", () => {
    for (const foldableCount of [0, 1]) {
      for (const status of [{}, { userChoice: true }, { interrupted: true }, { errored: true }]) {
        expect(turnFoldDecision({ foldableCount, settled: true, ...status }).canFold, `${foldableCount} ${JSON.stringify(status)}`).toBe(false)
      }
    }
  })
})

describe("foldedGroupKeys", () => {
  const parts = [reasoning("p1", "thinking"), tool("r1", "read"), tool("b1", "bash"), tool("b2", "bash"), text("t1", "the answer")]
  const groups = groupsOf(parts)

  test("folds every foldable group but the answer, the last text part", () => {
    expect(countFoldableGroups(groups, lookup(parts))).toBe(3)
    const keys = foldedGroupKeys(turnFoldDecision({ foldableCount: 3, settled: true }), groups, lookup(parts))
    expect([...keys]).toEqual(["part:a1:p1", "context:r1", "work:b1"])
  })

  test("keeps a group the reader opened, unless the fold was their explicit choice", () => {
    const opened = lookup(parts, new Set(["b2"]))
    expect([...foldedGroupKeys(turnFoldDecision({ foldableCount: 3, settled: true }), groups, opened)]).toEqual(["part:a1:p1", "context:r1"])
    expect([...foldedGroupKeys(turnFoldDecision({ foldableCount: 3, settled: true, userChoice: true }), groups, opened)]).toEqual(["part:a1:p1", "context:r1", "work:b1"])
  })
})

describe("turnFoldShape", () => {
  const partsBy = (rows: Record<string, AgentContentPart[]>) => (messageId: string) => rows[messageId] ?? []

  test("groups text with content, drops blank text, and shows reasoning only when asked", () => {
    const parts = { a1: [reasoning("p1", "thinking"), text("blank", "  \n"), text("t1", "answer")] }
    const hidden = turnFoldShape({ assistantMessages: [assistant("a1")], partsOf: partsBy(parts), hasText: partHasText, showReasoning: false, compaction: false })
    expect(hidden.refs.map((ref) => ref.part.id)).toEqual(["t1"])
    const shown = turnFoldShape({ assistantMessages: [assistant("a1")], partsOf: partsBy(parts), hasText: partHasText, showReasoning: true, compaction: false })
    expect(shown.refs.map((ref) => ref.part.id)).toEqual(["p1", "t1"])
  })

  test("a harness abort interrupts the turn at its message, drops tools it left running, and splits the groups there", () => {
    const messages = [assistant("a1", { error: { name: "MessageAbortedError", data: {} } }), assistant("a2")]
    const parts = {
      a1: [tool("b1", "bash", "completed"), tool("b2", "bash", "running"), text("t1", "stopped", "a1")],
      a2: [text("t2", "resumed", "a2")],
    }
    const shape = turnFoldShape({ assistantMessages: messages, partsOf: partsBy(parts), hasText: partHasText, showReasoning: false, compaction: false })
    expect(shape).toMatchObject({ interruptedMessageIndex: 0, harnessInterrupted: true, errorMessage: undefined, settled: true })
    expect(shape.refs.map((ref) => ref.part.id)).toEqual(["b1", "t1", "t2"])
    expect(turnSegments(shape.refs, shape).map(shapeOf)).toEqual([["part", "part"], ["part"]])
    expect(turnSegments(shape.refs, { ...shape, compaction: true }).map(shapeOf)).toEqual([["part", "part", "part"]])
  })

  test("an error's display text never makes it an interruption; the runtime's cancelled outcome names its own message", () => {
    const codex = [assistant("a1", { error: { name: "UnknownError", data: { message: "Codex turn aborted" } } })]
    expect(turnFoldShape({ assistantMessages: codex, partsOf: () => [], hasText: partHasText, showReasoning: false, compaction: false }))
      .toMatchObject({ interruptedMessageIndex: -1, harnessInterrupted: false, errorMessage: codex[0] })
    const cancelled = turnFoldShape({
      assistantMessages: [assistant("a1"), assistant("a2")],
      partsOf: () => [],
      hasText: partHasText,
      showReasoning: false,
      compaction: false,
      cancelledAssistantMessageId: "a2",
    })
    expect(cancelled).toMatchObject({ interruptedMessageIndex: 1, harnessInterrupted: false })
  })

  test("an error other than an abort is the turn's error, and a turn with no completed message is unsettled", () => {
    const failed = assistant("a1", { time: { created: 1 }, error: { name: "APIError", data: { message: "overloaded" } } })
    expect(turnFoldShape({ assistantMessages: [failed], partsOf: () => [], hasText: partHasText, showReasoning: false, compaction: false }))
      .toMatchObject({ interruptedMessageIndex: -1, errorMessage: { id: "a1", error: { name: "APIError" } }, settled: true })
    const running = assistant("a1", { time: { created: 1 } })
    expect(turnFoldShape({ assistantMessages: [running], partsOf: () => [], hasText: partHasText, showReasoning: false, compaction: false }).settled).toBe(false)
  })
})
