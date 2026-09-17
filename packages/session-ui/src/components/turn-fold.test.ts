import { describe, expect, test } from "bun:test"
import type { AgentAssistantMessage, AgentContentPart } from "@claxedo/agent-runtime-contract"
import { groupParts, type PartRef } from "./part-groups"
import {
  assistantMessageSettled,
  countFoldableGroups,
  foldedGroupKeys,
  isFoldableGroup,
  turnFoldDecision,
} from "./turn-fold"

function tool(id: string, name: string): AgentContentPart {
  return {
    id,
    sessionID: "ses_test",
    messageID: "a1",
    type: "tool",
    tool: name,
    callID: `${id}_c`,
    state: { status: "completed", input: {}, output: "ok", title: name, metadata: {}, time: { start: 1, end: 2 } },
  } as AgentContentPart
}

function text(id: string, value: string): AgentContentPart {
  return { id, sessionID: "ses_test", messageID: "a1", type: "text", text: value } as AgentContentPart
}

function turn(parts: AgentContentPart[]) {
  const byID = new Map(parts.map((part) => [part.id, part] as const))
  return {
    groups: groupParts(parts.map((part) => ({ messageID: "a1", part }))),
    part: (ref: PartRef) => byID.get(ref.partID),
  }
}

function assistant(fields: Partial<AgentAssistantMessage>): AgentAssistantMessage {
  return { id: "a1", sessionID: "ses_test", role: "assistant", time: {}, ...fields } as AgentAssistantMessage
}

const settledTurn = { settled: true, foldableCount: 4 }

describe("isFoldableGroup", () => {
  test("counts every tool group, subagent spawns included, not prose", () => {
    const { groups, part } = turn([
      text("p0", "prose"),
      tool("p1", "read"),
      tool("p2", "read"),
      tool("p3", "bash"),
      tool("p4", "task"),
      tool("p5", "task"),
    ])
    expect(groups.map((group) => group.type)).toEqual(["part", "context", "part", "agents"])
    expect(groups.map((group) => isFoldableGroup(group, part))).toEqual([false, true, true, true])
    expect(countFoldableGroups(groups, part)).toBe(3)
  })

  test("a subagent spawn folds whether it grouped or stands alone", () => {
    const grouped = turn([tool("p1", "bash"), tool("p2", "agent"), tool("p3", "agent")])
    expect(grouped.groups.map((group) => isFoldableGroup(group, grouped.part))).toEqual([true, true])

    const alone = turn([tool("p1", "bash"), tool("p2", "bash"), tool("p3", "agent")])
    expect(alone.groups.map((group) => group.type)).toEqual(["work", "agents"])
    expect(alone.groups.map((group) => isFoldableGroup(group, alone.part))).toEqual([true, true])
  })

  test("an answered question stays visible and does not count toward the fold", () => {
    const { groups, part } = turn([tool("p1", "bash"), tool("p2", "bash"), tool("p3", "question"), text("p4", "done")])
    expect(groups.map((group) => group.type)).toEqual(["work", "part", "part"])
    expect(groups.map((group) => isFoldableGroup(group, part))).toEqual([true, false, false])
    expect(countFoldableGroups(groups, part)).toBe(1)
    const decision = turnFoldDecision({ settled: true, foldableCount: countFoldableGroups(groups, part) })
    expect(foldedGroupKeys(decision, groups, part).size).toBe(0)
  })

  test("a bash row and a subagent group are enough for a settled turn to fold", () => {
    const { groups, part } = turn([text("p0", "prose"), tool("p1", "bash"), tool("p2", "agent"), tool("p3", "agent")])
    const decision = turnFoldDecision({ settled: true, foldableCount: countFoldableGroups(groups, part) })
    expect(decision.canFold).toBe(true)
    expect([...foldedGroupKeys(decision, groups, part)]).toEqual(["part:a1:p1", "agents:p2"])
  })

  test("a standalone group whose part is gone is not foldable", () => {
    const { groups } = turn([tool("p1", "bash")])
    expect(isFoldableGroup(groups[0], () => undefined)).toBe(false)
  })
})

describe("turnFoldDecision", () => {
  test("a settled turn folds from two foldable groups", () => {
    expect(turnFoldDecision({ settled: true, foldableCount: 1 }).canFold).toBe(false)
    expect(turnFoldDecision({ settled: true, foldableCount: 2 }).canFold).toBe(true)
    expect(turnFoldDecision({ ...settledTurn }).folded).toBe(true)
  })

  test("the settled fold is on by default and can be opted out", () => {
    expect(turnFoldDecision({ ...settledTurn, foldWhenSettled: false }).canFold).toBe(false)
  })

  test("an interrupted or failed turn keeps its control but does not fold itself", () => {
    for (const outcome of [{ interrupted: true }, { errored: true }]) {
      const decision = turnFoldDecision({ ...settledTurn, ...outcome })
      expect(decision.canFold).toBe(true)
      expect(decision.folded).toBe(false)
    }
  })

  test("a reader can still collapse a turn that was interrupted while expanded", () => {
    expect(turnFoldDecision({ ...settledTurn, interrupted: true, userChoice: true }).folded).toBe(true)
  })

  test("an explicit user choice beats the auto-fold", () => {
    expect(turnFoldDecision({ ...settledTurn, userChoice: false }).folded).toBe(false)
    expect(turnFoldDecision({ ...settledTurn, userChoice: true }).folded).toBe(true)
    expect(turnFoldDecision({ settled: true, foldableCount: 1, userChoice: true }).folded).toBe(false)
  })

  test("a turn the session is still working on has no fold, even by hand", () => {
    expect(turnFoldDecision({ settled: false, busy: true, foldableCount: 4 }).canFold).toBe(false)
    expect(turnFoldDecision({ settled: false, busy: true, foldableCount: 4, userChoice: true }).folded).toBe(false)
  })

  test("a multi-step turn whose first step completed is still running while the session is busy on it", () => {
    expect(turnFoldDecision({ settled: true, busy: true, foldableCount: 4 }).canFold).toBe(false)
    expect(turnFoldDecision({ settled: true, busy: false, foldableCount: 4 }).canFold).toBe(true)
  })

  test("a turn that failed while the session was still busy keeps its control", () => {
    const decision = turnFoldDecision({ settled: true, busy: true, errored: true, foldableCount: 4 })
    expect(decision.canFold).toBe(true)
    expect(decision.folded).toBe(false)
  })
})

describe("foldedGroupKeys", () => {
  const { groups, part } = turn([
    text("p0", "prose"),
    tool("p1", "read"),
    tool("p2", "bash"),
    tool("p3", "bash"),
    tool("p4", "grep"),
    tool("p5", "glob"),
  ])

  test("a settled fold hides every machinery group and keeps the prose", () => {
    const decision = turnFoldDecision({ settled: true, foldableCount: countFoldableGroups(groups, part) })
    const keys = foldedGroupKeys(decision, groups, part)
    expect(groups.filter((group) => !keys.has(group.key)).map((group) => group.type)).toEqual(["part"])
  })

  test("a settled fold hides the subagent card with the rest and keeps only the prose", () => {
    const withAgents = turn([
      text("p0", "prose"),
      tool("p1", "read"),
      tool("p2", "bash"),
      tool("p3", "bash"),
      tool("p4", "agent"),
      tool("p5", "agent"),
    ])
    const decision = turnFoldDecision({
      settled: true,
      foldableCount: countFoldableGroups(withAgents.groups, withAgents.part),
    })
    const keys = foldedGroupKeys(decision, withAgents.groups, withAgents.part)
    expect(withAgents.groups.filter((group) => !keys.has(group.key)).map((group) => group.type)).toEqual(["part"])
  })

  test("a running fold keeps in-flight subagents on screen as the live group", () => {
    const withAgents = turn([
      text("p0", "prose"),
      tool("p1", "read"),
      tool("p2", "bash"),
      tool("p3", "bash"),
      tool("p4", "agent"),
      tool("p5", "agent"),
    ])
    const decision = turnFoldDecision({
      settled: false,
      busy: true,
      foldableCount: countFoldableGroups(withAgents.groups, withAgents.part),
    })
    expect(foldedGroupKeys(decision, withAgents.groups, withAgents.part).size).toBe(0)
  })
})

describe("assistantMessageSettled", () => {
  test("a completion stamp or an error settles the message", () => {
    expect(assistantMessageSettled(assistant({ time: { created: 1, completed: 2 } }))).toBe(true)
    expect(
      assistantMessageSettled(assistant({ time: { created: 1 }, error: { name: "UnknownError", data: {} } })),
    ).toBe(true)
    expect(assistantMessageSettled(assistant({ time: { created: 1 } }))).toBe(false)
  })
})

describe("narration", () => {
  function reasoning(id: string, value: string): AgentContentPart {
    return { id, sessionID: "ses_test", messageID: "a1", type: "reasoning", text: value, time: { start: 1 } } as AgentContentPart
  }

  const narratedTurn = () =>
    turn([
      text("t0", "Let me look at the config."),
      tool("p1", "bash"),
      tool("p2", "bash"),
      reasoning("r0", "thinking about it"),
      text("t1", "Now the second step."),
      tool("p3", "bash"),
      tool("p4", "bash"),
      text("t2", "Here is the answer."),
    ])

  test("every text and reasoning row stays outside the fold", () => {
    const { groups, part } = narratedTurn()
    const outside = groups.filter((group) => !isFoldableGroup(group, part))
    expect(outside.map((group) => (group.type === "part" ? group.ref.partID : group.type))).toEqual([
      "t0",
      "r0",
      "t1",
      "t2",
    ])
  })

  test("folding a narrated turn hides its tool runs and nothing else", () => {
    const { groups, part } = narratedTurn()
    const decision = turnFoldDecision({ settled: true, foldableCount: countFoldableGroups(groups, part) })
    const folded = foldedGroupKeys(decision, groups, part)
    expect([...folded]).toEqual(["work:p1", "work:p3"])
  })
})
