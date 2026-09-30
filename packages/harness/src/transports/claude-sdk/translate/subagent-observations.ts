import { asText as text } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/helpers/guards"
import { hostSubagentBinding, hostSubagentObservation, isHostSubagentTool } from "../../../translate/host-subagent"
import { assistantToolBlocks } from "./assistant-content"
import { taskCall, type ClaudeSubagentObservation } from "./subagent-observation"
import { claudeChildCorrelationKey } from "./subagent-routing"
import type { ClaudeTaskLedger } from "./task-ledger"
import { taskSystemObservations } from "./task-observations"
import { isTaskTool } from "./tool-blocks"
import { toolResultBlocks } from "./tool-results"

export function claudeSubagentObservations(value: unknown, ledger: ClaudeTaskLedger): ClaudeSubagentObservation[] {
  const message = asRecord(value)
  if (!message) return []
  const harnessExecutionId = text(message.session_id)
  const wrapperId = text(message.uuid) ?? harnessExecutionId ?? "unknown"
  if (message.type === "assistant") {
    recordHostSubagentCalls(message, ledger)
    return claudeChildCorrelationKey(message) ? [] : spawnObservations(message, wrapperId, harnessExecutionId, ledger)
  }
  if (message.type === "user") return agentResultObservations(message, wrapperId, harnessExecutionId, ledger)
  if (message.type !== "system") return []
  return taskSystemObservations(message, wrapperId, harnessExecutionId, ledger)
}

function recordHostSubagentCalls(message: Record<string, unknown>, ledger: ClaudeTaskLedger) {
  const fromParent = !claudeChildCorrelationKey(message)
  for (const { tool } of assistantToolBlocks(message)) {
    if (!isHostSubagentTool(tool.toolName)) continue
    ledger.startHostSubagentCall(tool.toolCallId)
    if (fromParent) ledger.startSpawnCall(tool.toolCallId)
  }
}

function spawnObservations(
  message: Record<string, unknown>,
  wrapperId: string,
  harnessExecutionId: string | undefined,
  ledger: ClaudeTaskLedger,
): ClaudeSubagentObservation[] {
  return assistantToolBlocks(message).flatMap(({ tool }) => {
    if (!isTaskTool(tool.toolName) || isHostSubagentTool(tool.toolName) || !tool.toolCallId) return []
    ledger.startSpawnCall(tool.toolCallId)
    return [{
      observationId: `claude:agent-tool:${wrapperId}:${tool.toolCallId}`,
      ...(harnessExecutionId ? { harnessExecutionId } : {}),
      toolCallId: tool.toolCallId,
      toolCallRole: "spawn" as const,
      mode: tool.input?.run_in_background === true ? "background" as const : "foreground" as const,
      status: "pending" as const,
      label: text(tool.input?.description) ?? "Subagent",
      ...(text(tool.input?.subagent_type) ? { subagentType: text(tool.input?.subagent_type) } : {}),
      ...(text(tool.input?.description) ?? text(tool.input?.prompt)
        ? { description: text(tool.input?.description) ?? text(tool.input?.prompt) }
        : {}),
      providerKind: "claude-agent",
      transcript: { kind: "messages" as const },
    }]
  })
}

function agentResultObservations(
  message: Record<string, unknown>,
  wrapperId: string,
  harnessExecutionId: string | undefined,
  ledger: ClaudeTaskLedger,
): ClaudeSubagentObservation[] {
  const result = asRecord(message.tool_use_result)
  const agentId = text(result?.agentId)
  if (!agentId) return claudeHostSubagentObservations(message, wrapperId, harnessExecutionId, ledger)
  if (claudeChildCorrelationKey(message)) return []
  const blocks = toolResultBlocks(message)
  const sole = blocks.length === 1 ? blocks[0] : undefined
  if (!sole) return []
  return [{
    observationId: `claude:agent-result:${wrapperId}:${sole.toolCallId}`,
    ...(harnessExecutionId ? { harnessExecutionId } : {}),
    ...taskCall(sole.toolCallId, ledger),
    status: result?.status === "completed" || result?.status === "forked"
      ? "completed" as const
      : result?.status === "failed" || result?.status === "error"
        ? "failed" as const
        : "running" as const,
    ...(result?.status === "async_launched" ? { mode: "background" as const } : {}),
    providerId: agentId,
    providerKind: "claude-agent",
    transcript: { kind: "messages" as const },
  }]
}

function claudeHostSubagentObservations(
  message: Record<string, unknown>,
  wrapperId: string,
  harnessExecutionId: string | undefined,
  ledger: ClaudeTaskLedger,
): ClaudeSubagentObservation[] {
  const blocks = toolResultBlocks(message)
  return blocks.flatMap((tool) => {
    if (!ledger.isHostSubagentCall(tool.toolCallId)) return []
    const binding = hostSubagentBinding(tool.block)
      ?? (blocks.length === 1 ? hostSubagentBinding(message.tool_use_result) : undefined)
    if (!binding) return []
    return [{
      ...hostSubagentObservation({
        observationId: `claude:host-subagent:${wrapperId}:${tool.toolCallId}`,
        ...(harnessExecutionId ? { harnessExecutionId } : {}),
        toolCallId: tool.toolCallId,
        binding,
      }),
      ...taskCall(tool.toolCallId, ledger),
    }]
  })
}
