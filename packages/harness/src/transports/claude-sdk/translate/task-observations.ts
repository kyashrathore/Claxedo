import { asText as text, type SubagentObservation } from "@claxedo/agent-runtime-contract"
import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"
import { taskCall, type ClaudeTaskLedger, type ClaudeTaskRecord } from "./task-ledger"

type TaskUpdate = Pick<SubagentObservation, "mode" | "status" | "subagentType" | "description" | "label">

export function taskSystemObservations(
  message: Record<string, unknown>,
  wrapperId: string,
  ledger: ClaudeTaskLedger,
): SubagentObservation[] {
  switch (message.subtype) {
    case "task_started":
      return taskStartedObservations(message, wrapperId, ledger)
    case "task_notification":
      if (!admittedTask(ledger.get(text(message.task_id)))) return []
      return [taskObservation(message, wrapperId, ledger, {
        status: message.status === "completed" ? "completed" : message.status === "failed" ? "failed" : "killed",
      })]
    case "task_updated":
      return taskUpdatedObservations(message, wrapperId, ledger)
    default:
      return []
  }
}

function taskStartedObservations(message: Record<string, unknown>, wrapperId: string, ledger: ClaudeTaskLedger): SubagentObservation[] {
  const taskId = text(message.task_id)
  if (!taskId) return []
  const toolUseId = text(message.tool_use_id)
  const nested = (toolUseId !== undefined && ledger.isNestedSubagentCall(toolUseId)) ||
    (asFiniteNumber(message.spawn_depth) ?? 0) > 1
  const record: ClaudeTaskRecord = {
    taskId,
    ...(toolUseId ? { toolUseId } : {}),
    isAgentTask: !!text(message.subagent_type),
    skipTranscript: message.skip_transcript === true,
    ...(nested ? { nested } : {}),
  }
  ledger.start(record)
  if (!admittedTask(record)) return []
  const description = text(message.description)
  return [taskObservation(message, wrapperId, ledger, {
    status: "running",
    ...(description ? { description, label: description } : {}),
    subagentType: text(message.subagent_type),
  })]
}

function taskUpdatedObservations(message: Record<string, unknown>, wrapperId: string, ledger: ClaudeTaskLedger): SubagentObservation[] {
  if (!admittedTask(ledger.get(text(message.task_id)))) return []
  const patch = asRecord(message.patch) ?? {}
  const status = taskStatus(patch.status)
  const mode = patch.is_backgrounded === true ? "background" as const : patch.is_backgrounded === false ? "foreground" as const : undefined
  if (!status && !mode && !text(patch.description)) return []
  return [taskObservation(message, wrapperId, ledger, {
    ...(status ? { status } : {}),
    ...(mode ? { mode } : {}),
    description: text(patch.description),
  })]
}

function admittedTask(record: ClaudeTaskRecord | undefined) {
  return record?.isAgentTask && !record.skipTranscript && !record.nested ? record : undefined
}

function taskStatus(value: unknown): SubagentObservation["status"] {
  if (value === "pending" || value === "running" || value === "completed" || value === "failed" || value === "killed" || value === "paused") return value
  return undefined
}

function taskObservation(
  message: Record<string, unknown>,
  observationId: string,
  ledger: ClaudeTaskLedger,
  update: TaskUpdate,
): SubagentObservation {
  const taskId = text(message.task_id)
  return {
    observationId: `claude:${text(message.subtype)}:${observationId}`,
    ...(text(message.session_id) ? { harnessExecutionId: text(message.session_id) } : {}),
    ...(taskId ? { stableCorrelationId: taskId } : {}),
    ...taskCall(text(message.tool_use_id), ledger),
    ...Object.fromEntries(Object.entries(update).filter(([, value]) => value)),
    providerKind: "claude-agent",
    transcript: { kind: "messages" },
  }
}
