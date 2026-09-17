import { describe, expect, test } from "bun:test"
import { presentationEventsFromRuntimeEnvelope } from "./runtime-envelope"

describe("presentationEventsFromRuntimeEnvelope", () => {
  test("a subagent revision becomes one subagent.updated frame keyed by row and revision", () => {
    const events = presentationEventsFromRuntimeEnvelope({
      directory: "/w",
      sessionId: "parent",
      payload: { type: "subagent-updated", subagentKey: "child-1", revision: 3, status: "running", label: "Explore" },
    })
    expect(events).toEqual([{
      directory: "/w",
      payload: {
        id: "subagent.updated:parent:child-1:3",
        type: "subagent.updated",
        properties: { sessionID: "parent", update: { subagentKey: "child-1", revision: 3, status: "running", label: "Explore" } },
      },
    }])
  })

  test("goal changes become goal.updated and goal.cleared for the goal's own session", () => {
    const goal = { sessionId: "ses", objective: "ship", status: "active" as const, createdAt: 1, updatedAt: 2 }
    expect(presentationEventsFromRuntimeEnvelope({ directory: "/w", sessionId: "ses", payload: { type: "goal-updated", sessionId: "ses", goal } }))
      .toEqual([{ directory: "/w", payload: { id: "goal.updated:ses:2", type: "goal.updated", properties: { sessionID: "ses", goal } } }])
    expect(presentationEventsFromRuntimeEnvelope({ directory: "/w", sessionId: "ses", payload: { type: "goal-cleared", sessionId: "ses" } }))
      .toEqual([{ directory: "/w", payload: { id: "goal.cleared:ses", type: "goal.cleared", properties: { sessionID: "ses" } } }])
  })

  test("everything the turn projection already covers, or that stays in-process, crosses no wire", () => {
    for (const payload of [
      { type: "text-delta" as const, delta: "x" },
      { type: "tool-output" as const, toolCallId: "c", output: "ok" },
      { type: "diagnostic" as const, diagnostic: { code: "x", message: "m", severity: "warn" as const, source: "test" } },
      { type: "finish" as const, sessionId: "ses" },
    ]) {
      expect(presentationEventsFromRuntimeEnvelope({ directory: "/w", sessionId: "ses", payload })).toEqual([])
    }
  })
})
