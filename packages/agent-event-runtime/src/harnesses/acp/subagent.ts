import type { SubagentMode, SubagentStatus, SubagentToolCallRole, SubagentTranscript } from "../../contracts/agent-runtime-event"
import type { SessionUpdate } from "./types"

export type AcpSubagentObservation = {
  observationId: string
  stableCorrelationId: string
  toolCallId: string
  toolCallRole: SubagentToolCallRole
  mode?: SubagentMode
  status?: SubagentStatus
  label?: string
  subagentType?: string
  description?: string
  providerId?: string
  providerKind?: string
  transcript: SubagentTranscript
}

export type AcpSubagentUpdate =
  | { kind: "child"; correlationKey: string }
  | { kind: "lifecycle"; correlationKey: string; observation: AcpSubagentObservation }

export function classifyAcpSubagentUpdate(
  client: string,
  update: SessionUpdate,
  prior?: AcpSubagentObservation,
): AcpSubagentUpdate | undefined {
  const row = update as unknown as Record<string, unknown>
  const meta = object(row._meta)
  const claude = object(meta?.claudeCode)
  const parentToolUseId = text(claude?.parentToolUseId) ?? text(claude?.parent_tool_use_id)
  if (parentToolUseId) return { kind: "child", correlationKey: parentToolUseId }
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return

  if (prior) {
    return lifecycle(update, {
      toolCallRole: prior.toolCallRole,
      ...(prior.mode ? { mode: prior.mode } : {}),
      ...(acpStatus(update.status) ? { status: acpStatus(update.status) } : {}),
      ...(prior.label ? { label: prior.label } : {}),
      ...(prior.subagentType ? { subagentType: prior.subagentType } : {}),
      ...(prior.description ? { description: prior.description } : {}),
      ...(prior.providerId ? { providerId: prior.providerId } : {}),
      ...(prior.providerKind ? { providerKind: prior.providerKind } : {}),
      transcript: prior.transcript,
    })
  }

  const rawInput = object(update.rawInput)
  const title = update.title?.trim().toLowerCase()
  if (client === "claude-acp" && (
    claude?.subagent === true ||
    title === "agent" ||
    title === "task" ||
    title?.startsWith("task ") ||
    !!text(rawInput?.subagentType) ||
    !!text(rawInput?.subagent_type)
  )) {
    return lifecycle(update, {
      toolCallRole: "spawn",
      mode: rawInput?.run_in_background === true ? "background" : "foreground",
      status: acpStatus(update.status) ?? (update.sessionUpdate === "tool_call" ? "running" : undefined),
      label: update.title ?? undefined,
      subagentType: text(rawInput?.subagentType) ?? text(rawInput?.subagent_type),
      description: text(rawInput?.description) ?? text(rawInput?.prompt),
      transcript: { kind: "messages", ref: `acp:${update.toolCallId}` },
    })
  }

  if (client === "codex-acp") {
    const codexSubagent = object(object(meta?.codex)?.subagent)
    const activity = text(rawInput?.activityKind) ?? text(codexSubagent?.activity) ?? codexActivity(update.title)
    if (!activity) return
    const providerId = text(rawInput?.agentThreadId) ?? text(codexSubagent?.threadId)
    return lifecycle(update, {
      toolCallRole: activity === "started" ? "spawn" : "interaction",
      status: codexStatus(activity, update.status),
      label: update.title ?? undefined,
      providerId,
      providerKind: providerId ? "codex-acp-thread" : undefined,
      transcript: { kind: "none" },
    })
  }

  if (client === "cursor-acp" && update.title?.trim().toLowerCase() === "task: subagent task") {
    const rawInput = object(update.rawInput)
    return lifecycle(update, {
      toolCallRole: "spawn",
      status: acpStatus(update.status) ?? (update.sessionUpdate === "tool_call" ? "running" : undefined),
      label: update.title,
      description: text(rawInput?.description),
      transcript: { kind: "none" },
    })
  }
}

function lifecycle(
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
  observation: Omit<AcpSubagentObservation, "observationId" | "stableCorrelationId" | "toolCallId">,
): AcpSubagentUpdate {
  const phase = update.status ?? (update.sessionUpdate === "tool_call" ? "started" : "updated")
  return {
    kind: "lifecycle",
    correlationKey: update.toolCallId,
    observation: {
      observationId: `${update.toolCallId}:${update.sessionUpdate}:${phase}:${observation.status ?? "observed"}`,
      stableCorrelationId: update.toolCallId,
      toolCallId: update.toolCallId,
      ...observation,
    },
  }
}

function codexActivity(title: string | null | undefined) {
  const value = title?.trim().toLowerCase()
  if (value?.startsWith("start subagent ")) return "started"
  if (value?.startsWith("interact with subagent ")) return "interacted"
  if (value?.startsWith("interrupt subagent ")) return "interrupted"
}

function codexStatus(activity: string, status: unknown): SubagentStatus | undefined {
  if (status === "failed") return "failed"
  if (activity === "interrupted" && status === "completed") return "interrupted"
  if (status === "pending") return "pending"
  return "running"
}

function acpStatus(status: unknown): SubagentStatus | undefined {
  if (status === "pending") return "pending"
  if (status === "in_progress") return "running"
  if (status === "completed") return "completed"
  if (status === "failed") return "failed"
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function text(value: unknown) {
  if (typeof value !== "string" || !value) return
  return value
}
