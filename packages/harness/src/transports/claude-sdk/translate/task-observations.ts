import { asText as text } from "@claxedo/agent-runtime-contract"
import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"
import { taskCall, type ClaudeSubagentObservation } from "./subagent-observation"
import type { ClaudeTaskLedger, ClaudeTaskRecord } from "./task-ledger"

type TaskUpdate = Omit<ClaudeSubagentObservation, "observationId" | "harnessExecutionId" | "stableCorrelationId" | "toolCallId" | "toolCallRole" | "providerKind" | "transcript">

export function taskSystemObservations(
  message: Record<string, unknown>,
  wrapperId: string,
  harnessExecutionId: string | undefined,
  ledger: ClaudeTaskLedger,
): ClaudeSubagentObservation[] {
  switch (message.subtype) {
    case "task_started":
      return taskStartedObservations(message, wrapperId, harnessExecutionId, ledger)
    case "task_progress":
      if (!admittedTask(ledger.get(text(message.task_id)))) return []
      return [taskObservation(message, wrapperId, ledger, {
        status: "running",
        description: text(message.description),
        subagentType: text(message.subagent_type),
      })]
    case "task_notification":
      if (!admittedTask(ledger.get(text(message.task_id)))) return []
      return [taskObservation(message, wrapperId, ledger, {
        status: message.status === "completed" ? "completed" : message.status === "failed" ? "failed" : "killed",
        description: text(message.summary),
      })]
    case "task_updated":
      return taskUpdatedObservations(message, wrapperId, ledger)
    case "background_tasks_changed":
      return ledger
        .replaceLive(liveTaskIds(message))
        .flatMap((record) => admittedTask(record) ? [departedTaskObservation(record, wrapperId, ledger)] : [])
    default:
      return []
  }
}

function taskStartedObservations(
  message: Record<string, unknown>,
  wrapperId: string,
  harnessExecutionId: string | undefined,
  ledger: ClaudeTaskLedger,
): ClaudeSubagentObservation[] {
  const taskId = text(message.task_id)
  if (!taskId) return []
  const toolUseId = text(message.tool_use_id)
  const nested = (toolUseId !== undefined && ledger.isNestedSubagentCall(toolUseId)) ||
    (asFiniteNumber(message.spawn_depth) ?? 0) > 1
  const record: ClaudeTaskRecord = {
    taskId,
    ...(toolUseId ? { toolUseId } : {}),
    ...(harnessExecutionId ? { harnessExecutionId } : {}),
    isAgentTask: !!text(message.subagent_type),
    skipTranscript: message.skip_transcript === true,
    ...(nested ? { nested } : {}),
  }
  ledger.start(record)
  if (!admittedTask(record)) return []
  return [taskObservation(message, wrapperId, ledger, {
    status: "running",
    description: text(message.description),
    subagentType: text(message.subagent_type),
  })]
}

function taskUpdatedObservations(message: Record<string, unknown>, wrapperId: string, ledger: ClaudeTaskLedger): ClaudeSubagentObservation[] {
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

function liveTaskIds(message: Record<string, unknown>) {
  const tasks = Array.isArray(message.tasks) ? message.tasks : []
  return tasks.flatMap((value) => text(asRecord(value)?.task_id) ?? [])
}

function departedTaskObservation(record: ClaudeTaskRecord, wrapperId: string, ledger: ClaudeTaskLedger): ClaudeSubagentObservation {
  return {
    observationId: `claude:background_tasks_changed:${wrapperId}:${record.taskId}`,
    ...(record.harnessExecutionId ? { harnessExecutionId: record.harnessExecutionId } : {}),
    stableCorrelationId: record.taskId,
    ...taskCall(record.toolUseId, ledger),
    status: "interrupted",
    providerKind: "claude-agent",
    transcript: { kind: "messages" },
  }
}

function taskStatus(value: unknown): ClaudeSubagentObservation["status"] {
  if (value === "pending" || value === "running" || value === "completed" || value === "failed" || value === "killed" || value === "paused") return value
  return undefined
}

function taskObservation(
  message: Record<string, unknown>,
  observationId: string,
  ledger: ClaudeTaskLedger,
  update: TaskUpdate,
): ClaudeSubagentObservation {
  const taskId = text(message.task_id)
  return {
    observationId: `claude:${text(message.subtype)}:${observationId}`,
    ...(text(message.session_id) ? { harnessExecutionId: text(message.session_id) } : {}),
    ...(taskId ? { stableCorrelationId: taskId } : {}),
    ...taskCall(text(message.tool_use_id), ledger),
    ...(update.mode ? { mode: update.mode } : {}),
    ...(update.status ? { status: update.status } : {}),
    ...(update.subagentType ? { subagentType: update.subagentType } : {}),
    ...(update.description ? { description: update.description, label: update.description } : {}),
    providerKind: "claude-agent",
    transcript: { kind: "messages" },
  }
}
