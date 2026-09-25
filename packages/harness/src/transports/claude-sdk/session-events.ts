import type { SDKActiveGoalMessage, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { HarnessSession, SessionBroker } from "../../contract"
import { activeGoal } from "./goal-state"

export async function observeClaudeSessionMessage(message: SDKMessage | SDKActiveGoalMessage,
  session: HarnessSession, broker: SessionBroker, signal: AbortSignal): Promise<{ kind: "active-goal" } | { kind: "message"; message: SDKMessage }> {
  if ("session_id" in message && typeof message.session_id === "string" && message.session_id &&
    session.binding.upstreamSessionId !== message.session_id) {
    session.binding.upstreamSessionId = message.session_id
    await broker.rebind(message.session_id)
  }
  if (message.type !== "active_goal") return { kind: "message", message }
  if (!signal.aborted) await broker.goal.publish(activeGoal(session.binding.sessionId, message))
  return { kind: "active-goal" }
}
