import { expect, test } from "bun:test"
import type { SDKActiveGoalMessage, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { HarnessSession, SessionBroker } from "../../contract"
import { observeClaudeSessionMessage } from "./session-events"

test("terminal results rebind before translation, the holder adopts the committed binding, and late Goal updates stay discarded", async () => {
  const order: string[] = []
  const unbound: HarnessSession = { directory: "/work", locality: "local", binding: Object.freeze({ sessionId: "s1", workspaceId: "w1",
    directory: "/work", connectionId: "claude-sdk", upstreamSessionId: "claude-sdk:unbound" }) }
  const holder = { session: unbound }
  const broker = { rebind: async (id: string) => { order.push(`rebind ${id}`); return Object.freeze({ ...unbound.binding, upstreamSessionId: id }) },
    goal: { publish: async () => { order.push("goal") } } } as unknown as SessionBroker
  const signal = new AbortController()
  expect((await observeClaudeSessionMessage({ type: "result", session_id: "up1" } as SDKMessage,
    holder, broker, signal.signal)).kind).toBe("message")
  expect(holder.session.binding.upstreamSessionId).toBe("up1")
  const goal = { type: "active_goal", session_id: "up2", uuid: "00000000-0000-0000-0000-000000000001", value: { condition: "Ship", iterations: 1,
    set_at: 1_700_000_000, tokens_at_start: 0 } } as SDKActiveGoalMessage
  expect((await observeClaudeSessionMessage(goal, holder, broker, signal.signal)).kind).toBe("active-goal")
  signal.abort()
  expect((await observeClaudeSessionMessage(goal, holder, broker, signal.signal)).kind).toBe("active-goal")
  expect(holder.session.binding.upstreamSessionId).toBe("up2")
  expect(unbound.binding.upstreamSessionId).toBe("claude-sdk:unbound")
  expect(order).toEqual(["rebind up1", "rebind up2", "goal"])
})

test("a permission mode Claude moves to itself is reported as the mode it keeps", async () => {
  const session: HarnessSession = { directory: "/work", locality: "local", binding: Object.freeze({ sessionId: "s1", workspaceId: "w1",
    directory: "/work", connectionId: "claude-sdk", upstreamSessionId: "up1" }) }
  const kept: unknown[] = []
  const holder = { session, input: { permissionModeKept: async (mode: unknown) => { kept.push(mode) } } }
  const status = (permissionMode?: string) => ({ type: "system", subtype: "status", status: null, ...(permissionMode ? { permissionMode } : {}),
    uuid: "793a379a-073b-4cc9-820e-f6052518039c", session_id: "up1" }) as SDKMessage
  const broker = {} as SessionBroker
  await observeClaudeSessionMessage(status("plan"), holder, broker, new AbortController().signal)
  await observeClaudeSessionMessage(status(), holder, broker, new AbortController().signal)
  expect(kept).toEqual([{ modeId: "plan", label: "Plan" }])
})
