import { expect, test } from "bun:test"
import type { SDKActiveGoalMessage, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { HarnessVersionGate, type HarnessSession, type SessionBroker } from "../../contract"
import { CLAUDE_CODE_RANGE } from "./cli-version"
import { observeClaudeSessionMessage } from "./session-events"

test("terminal results rebind before translation, the holder adopts the committed binding, and late Goal updates stay discarded", async () => {
  const order: string[] = []
  const unbound: HarnessSession = { directory: "/work", locality: "local", binding: Object.freeze({ sessionId: "s1", workspaceId: "w1",
    directory: "/work", connectionId: "claude-sdk", upstreamSessionId: "claude-sdk:unbound" }) }
  const holder = { session: unbound }
  const broker = { rebind: async (id: string) => { order.push(`rebind ${id}`); return Object.freeze({ ...unbound.binding, upstreamSessionId: id }) },
    goal: { publish: async () => { order.push("goal") } } } as unknown as SessionBroker
  const signal = new AbortController()
  const versions = new HarnessVersionGate(CLAUDE_CODE_RANGE, "claude.sdk")
  expect((await observeClaudeSessionMessage({ type: "result", session_id: "up1" } as SDKMessage,
    holder, broker, signal.signal, versions)).kind).toBe("message")
  expect(holder.session.binding.upstreamSessionId).toBe("up1")
  const goal = { type: "active_goal", session_id: "up2", uuid: "00000000-0000-0000-0000-000000000001", value: { condition: "Ship", iterations: 1,
    set_at: 1_700_000_000, tokens_at_start: 0 } } as SDKActiveGoalMessage
  expect((await observeClaudeSessionMessage(goal, holder, broker, signal.signal, versions)).kind).toBe("active-goal")
  signal.abort()
  expect((await observeClaudeSessionMessage(goal, holder, broker, signal.signal, versions)).kind).toBe("active-goal")
  expect(holder.session.binding.upstreamSessionId).toBe("up2")
  expect(unbound.binding.upstreamSessionId).toBe("claude-sdk:unbound")
  expect(order).toEqual(["rebind up1", "rebind up2", "goal"])
})
