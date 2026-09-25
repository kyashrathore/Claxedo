import { expect, test } from "bun:test"
import type { SDKActiveGoalMessage, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { HarnessSession, SessionBroker } from "../../contract"
import { observeClaudeSessionMessage } from "./session-events"

test("terminal results rebind before translation and late Goal updates stay discarded", async () => {
  const order: string[] = []
  const session: HarnessSession = { directory: "/work", locality: "local", binding: { sessionId: "s1", workspaceId: "w1",
    directory: "/work", connectionId: "claude-sdk", upstreamSessionId: "claude-sdk:unbound" } }
  const broker = { rebind: async (id: string) => { order.push(`rebind ${id}`) },
    goal: { publish: async () => { order.push("goal") } } } as unknown as SessionBroker
  const signal = new AbortController()
  expect((await observeClaudeSessionMessage({ type: "result", session_id: "up1" } as SDKMessage,
    session, broker, signal.signal)).kind).toBe("message")
  const goal = { type: "active_goal", session_id: "up2", uuid: "00000000-0000-0000-0000-000000000001", value: { condition: "Ship", iterations: 1,
    set_at: 1_700_000_000, tokens_at_start: 0 } } as SDKActiveGoalMessage
  expect((await observeClaudeSessionMessage(goal, session, broker, signal.signal)).kind).toBe("active-goal")
  signal.abort()
  expect((await observeClaudeSessionMessage(goal, session, broker, signal.signal)).kind).toBe("active-goal")
  expect(session.binding.upstreamSessionId).toBe("up2")
  expect(order).toEqual(["rebind up1", "rebind up2", "goal"])
})
