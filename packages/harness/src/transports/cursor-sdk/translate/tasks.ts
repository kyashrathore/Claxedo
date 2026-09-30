import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"
import type { SubagentMode, SubagentStatus, SubagentToolCallRole } from "@claxedo/agent-runtime-contract"
import { asText as text } from "@claxedo/agent-runtime-contract"
import { hostSubagentBinding, hostSubagentObservation, isHostSubagentTool } from "../../../translate/host-subagent"
import { isTaskTool, successfulOutput, toolInput } from "./tools"

export type CursorSubagentObservation = {
  observationId: string
  harnessExecutionId?: string
  toolCallId: string
  toolCallRole: SubagentToolCallRole
  mode?: SubagentMode
  status?: SubagentStatus
  label?: string
  subagentType?: string
  description?: string
  providerId?: string
  providerKind?: string
  subagentKey?: string
  childSessionId?: string
  transcript: { kind: "none" | "live" }
}

function taskErrorMessage(value: unknown) {
  const row = asRecord(value)
  const nested = asRecord(row?.error)
  return text(row?.message) ?? text(nested?.message) ?? text(row?.error) ?? text(value) ?? "Cursor task failed"
}

export function taskOutput(value: unknown) {
  const result = asRecord(value)
  const success = result?.status === "success" ? asRecord(result.value) : undefined
  if (!success) return successfulOutput(value)
  return safeTaskSuccess(success)
}

function safeTaskSuccess(success: Record<string, unknown>) {
  return {
    ...(text(success.agentId) ? { agentId: text(success.agentId) } : {}),
    ...(typeof success.isBackground === "boolean" ? { isBackground: success.isBackground } : {}),
    ...(asFiniteNumber(success.durationMs) !== undefined ? { durationMs: asFiniteNumber(success.durationMs) } : {}),
    ...(text(success.resultSuffix) ? { resultSuffix: text(success.resultSuffix) } : {}),
    ...(text(success.backgroundReason) ? { backgroundReason: text(success.backgroundReason) } : {}),
  }
}

export function taskMetadata(value: unknown) {
  const result = asRecord(value)
  const success = result?.status === "success" ? asRecord(result.value) : undefined
  if (!success) return { transcript: "unavailable" }
  return {
    transcript: text(success.transcriptPath) ? "awaiting-host-resolution" : "unavailable",
    ...(text(success.agentId) ? { agentId: text(success.agentId) } : {}),
    ...(typeof success.isBackground === "boolean" ? { isBackground: success.isBackground } : {}),
    ...(asFiniteNumber(success.durationMs) !== undefined ? { durationMs: asFiniteNumber(success.durationMs) } : {}),
    ...(text(success.backgroundReason) ? { backgroundReason: text(success.backgroundReason) } : {}),
  }
}

export function cursorSubagentObservations(value: unknown): CursorSubagentObservation[] {
  const message = asRecord(value)
  if (!message || message.type !== "tool_call") return []
  const toolCallId = text(message.call_id)
  if (!toolCallId) return []
  if (isHostSubagentTool(text(message.name) ?? "")) {
    const binding = hostSubagentBinding(message.result)
    return binding
      ? [{
          ...hostSubagentObservation({
            observationId: `cursor:host-subagent:${text(message.run_id) ?? "unknown"}:${toolCallId}`,
            ...(text(message.run_id) ? { harnessExecutionId: text(message.run_id) } : {}),
            toolCallId,
            binding,
          }),
          toolCallRole: "spawn",
        }]
      : []
  }
  if (!isTaskTool(text(message.name) ?? "")) return []
  const args = toolInput(message.args)
  const result = asRecord(message.result)
  const success = result?.status === "success" ? asRecord(result.value) : undefined
  const providerId = text(success?.agentId) ?? text(args.agentId) ?? text(args.resume)
  const priorProviderId = text(args.agentId) ?? text(args.resume)
  const status = message.status === "running"
    ? "running"
    : message.status === "error" || result?.status === "error"
      ? "failed"
      : "completed"
  const subagentType = text(asRecord(args.subagentType)?.name) ?? text(asRecord(args.subagentType)?.kind)
  return [{
    observationId: `cursor:task:${text(message.run_id) ?? "unknown"}:${toolCallId}:${status}`,
    ...(text(message.run_id) ? { harnessExecutionId: text(message.run_id) } : {}),
    toolCallId,
    toolCallRole: priorProviderId ? "interaction" : "spawn",
    ...(typeof success?.isBackground === "boolean"
      ? { mode: success.isBackground ? "background" : "foreground" }
      : {}),
    status,
    ...(text(args.description) ? { label: text(args.description), description: text(args.description) } : {}),
    ...(subagentType ? { subagentType } : {}),
    ...(providerId ? { providerId } : {}),
    ...(providerId ? { providerKind: "cursor-agent" } : {}),
    transcript: { kind: "none" },
  }]
}

export function cursorRuntimeMessage(value: unknown) {
  const message = asRecord(value)
  if (!message || message.type !== "tool_call" || !isTaskTool(text(message.name) ?? "")) return value
  const result = asRecord(message.result)
  if (!result) return value
  if (result.status === "error") {
    return {
      ...message,
      result: { status: "error", error: taskErrorMessage(result.error) },
    }
  }
  if (result.status !== "success") return value
  return {
    ...message,
    result: { ...result, value: safeTaskSuccess(asRecord(result.value) ?? {}) },
  }
}
