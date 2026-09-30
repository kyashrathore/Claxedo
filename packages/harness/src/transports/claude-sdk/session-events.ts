import type { SDKActiveGoalMessage, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { HarnessSession, HarnessVersionGate, SessionBroker, StartInput } from "../../contract"
import { activeGoal } from "./goal-state"
import { claudeKeptMode } from "./permissions"

export type ClaudeSessionHolder = { session: HarnessSession; input?: Pick<StartInput, "permissionModeKept"> }

export async function observeClaudeSessionMessage(message: SDKMessage | SDKActiveGoalMessage, holder: ClaudeSessionHolder,
  broker: SessionBroker, signal: AbortSignal, versions: HarnessVersionGate): Promise<{ kind: "active-goal" } | { kind: "message"; message: SDKMessage }> {
  if ("session_id" in message && typeof message.session_id === "string" && message.session_id &&
    holder.session.binding.upstreamSessionId !== message.session_id) {
    holder.session = { ...holder.session, binding: await broker.rebind(message.session_id) }
  }
  if (message.type === "system" && message.subtype === "init") await versions.admit(message.claude_code_version, "claude/system", broker)
  if (message.type === "system" && message.subtype === "status" && message.permissionMode) {
    await holder.input?.permissionModeKept?.(claudeKeptMode(message.permissionMode))
  }
  if (message.type !== "active_goal") return { kind: "message", message }
  if (!signal.aborted) await broker.goal.publish(activeGoal(holder.session.binding.sessionId, message))
  return { kind: "active-goal" }
}
