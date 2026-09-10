import { describe, expect, test } from "bun:test"
import type { AgentAssistantMessage, AgentContentPart } from "@claxedo/agent-runtime-contract"
import { groupParts, type PartRef } from "./part-groups"
import {
  assistantMessageSettled,
  countFoldableGroups,
  foldedGroupKeys,
  finalTextPartID,
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
  test("counts machinery groups and standalone tools, not prose", () => {
    const { groups, part } = turn([
      text("p0", "prose"),
      tool("p1", "read"),
      tool("p2", "read"),
      tool("p3", "bash"),
      tool("p4", "task"),
      tool("p5", "task"),
    ])
    expect(groups.map((group) => isFoldableGroup(group, part))).toEqual([false, true, true, false])
    expect(countFoldableGroups(groups, part)).toBe(2)
  })

  test("a subagent spawn stays visible whether it grouped or stands alone", () => {
    const grouped = turn([tool("p1", "bash"), tool("p2", "agent"), tool("p3", "agent")])
    expect(grouped.groups.map((group) => isFoldableGroup(group, grouped.part))).toEqual([true, false])

    const alone = turn([tool("p1", "bash"), tool("p2", "bash"), tool("p3", "agent")])
    expect(alone.groups.map((group) => isFoldableGroup(group, alone.part))).toEqual([true, false])
  })

  test("a turn whose only machinery is subagents does not fold at all", () => {
    const { groups, part } = turn([text("p0", "prose"), tool("p1", "bash"), tool("p2", "agent"), tool("p3", "agent")])
    const decision = turnFoldDecision({ settled: true, foldableCount: countFoldableGroups(groups, part) })
    expect(decision.canFold).toBe(false)
    expect(foldedGroupKeys(decision, groups, part).size).toBe(0)
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

  test("the settled fold is on by default and the running fold is off", () => {
    expect(turnFoldDecision({ ...settledTurn, foldWhenSettled: false }).canFold).toBe(false)
    expect(turnFoldDecision({ settled: false, busy: true, foldableCount: 4 }).canFoldRunning).toBe(false)
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

  test("a running turn folds only when asked, and only from three foldable groups", () => {
    const running = { settled: false, busy: true, foldWhileRunning: true }
    expect(turnFoldDecision({ ...running, foldableCount: 2 }).canFold).toBe(false)
    expect(turnFoldDecision({ ...running, foldableCount: 3 }).canFoldRunning).toBe(true)
    expect(turnFoldDecision({ ...running, foldWhileRunning: false, foldableCount: 3 }).canFold).toBe(false)
    expect(turnFoldDecision({ settled: false, busy: false, foldWhileRunning: true, foldableCount: 3 }).canFold).toBe(
      false,
    )
  })

  test("running reports the label verb: only an unsettled, unfailed, busy turn is still working", () => {
    expect(turnFoldDecision({ settled: false, busy: true, foldableCount: 4 }).running).toBe(true)
    expect(turnFoldDecision({ settled: true, busy: true, foldableCount: 4 }).running).toBe(false)
    expect(turnFoldDecision({ settled: false, busy: true, errored: true, foldableCount: 4 }).running).toBe(false)
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

  test("a settled fold keeps the prose and the subagent card", () => {
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
    expect(withAgents.groups.filter((group) => !keys.has(group.key)).map((group) => group.type)).toEqual([
      "part",
      "agents",
    ])
  })

  test("an expanded turn hides nothing", () => {
    const decision = turnFoldDecision({ settled: true, foldableCount: 4, userChoice: false })
    expect(foldedGroupKeys(decision, groups, part).size).toBe(0)
  })

  test("folding a running turn by hand hides the live group too", () => {
    const running = { settled: false, busy: true, foldWhileRunning: true, foldableCount: countFoldableGroups(groups, part) }
    const auto = turnFoldDecision(running)
    const byHand = turnFoldDecision({ ...running, userChoice: true })
    expect(foldedGroupKeys(auto, groups, part).has(groups.at(-1)!.key)).toBe(false)
    expect(foldedGroupKeys(byHand, groups, part).has(groups.at(-1)!.key)).toBe(true)
  })

  test("a running fold keeps the live group on screen", () => {
    const decision = turnFoldDecision({
      settled: false,
      busy: true,
      foldWhileRunning: true,
      foldableCount: countFoldableGroups(groups, part),
    })
    const keys = foldedGroupKeys(decision, groups, part)
    expect(keys.has(groups.at(-1)!.key)).toBe(false)
    expect(keys.size).toBe(2)
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

describe("final-message shape", () => {
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

  test("finalTextPartID picks the last text group, not the longest or the first", () => {
    const { groups, part } = narratedTurn()
    expect(finalTextPartID(groups, part)).toBe("t2")
  })

  test("interleaved keeps every text and reasoning row outside the fold", () => {
    const { groups, part } = narratedTurn()
    const outside = groups.filter((group) => !isFoldableGroup(group, part))
    expect(outside.map((group) => (group.type === "part" ? group.ref.partID : group.type))).toEqual([
      "t0",
      "r0",
      "t1",
      "t2",
    ])
  })

  test("final-message folds narration and reasoning, leaving only the answer", () => {
    const { groups, part } = narratedTurn()
    const scope = { shape: "final-message" as const, finalTextPartID: finalTextPartID(groups, part) }
    const outside = groups.filter((group) => !isFoldableGroup(group, part, scope))
    expect(outside.map((group) => (group.type === "part" ? group.ref.partID : group.type))).toEqual(["t2"])
    expect(countFoldableGroups(groups, part, scope)).toBe(groups.length - 1)
  })

  test("a turn whose last text is missing folds every text row", () => {
    const { groups, part } = turn([text("t0", "narration"), tool("p1", "bash"), tool("p2", "bash")])
    const scope = { shape: "final-message" as const, finalTextPartID: undefined }
    expect(groups.filter((group) => !isFoldableGroup(group, part, scope))).toEqual([])
  })

  test("foldedGroupKeys hides the narration rows the interleaved shape leaves visible", () => {
    const { groups, part } = narratedTurn()
    const decision = turnFoldDecision({ settled: true, foldableCount: countFoldableGroups(groups, part) })
    const interleaved = foldedGroupKeys(decision, groups, part)
    const scope = { shape: "final-message" as const, finalTextPartID: finalTextPartID(groups, part) }
    const finalMessage = foldedGroupKeys(decision, groups, part, scope)
    expect(finalMessage.size).toBeGreaterThan(interleaved.size)
    expect([...finalMessage].some((key) => key.includes("t0"))).toBe(true)
    expect([...finalMessage].some((key) => key.includes("t2"))).toBe(false)
  })
})
