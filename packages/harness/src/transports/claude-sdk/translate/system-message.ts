import { asText as text } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"
import type { ClaudeSdkAdapterState, ClaudeTranslation } from "./adapter-state"
import { diagnosticForEvent, ignoredFrame, type ClaudeFrameEvent } from "./sdk-message"
import { systemNotice } from "./system-notices"
import type { ClaudeTranslatorMemory } from "./translator-memory"

const ignoredSubtypes: readonly string[] = ["thinking_tokens", "post_turn_summary", "task_summary", "vcs_state_changed", "session_title_changed",
  "hook_started", "hook_progress", "hook_response", "stop_hook_summary", "files_persisted", "elicitation_complete", "plugin_install",
  "session_state_changed", "worker_shutting_down", "control_request_progress", "turn_duration", "turn_preempted", "away_summary",
  "memory_saved", "agents_killed", "thinking", "file_snapshot", "scheduled_task_fire", "peer_message_hold", "api_error", "permission_retry",
  "session_metadata", "feedback_draft_queued", "turn_handoff_available", "ui_invalidate", "ui_log", "ui_toast", "ui_status", "ui_panes",
  "ui_scroll", "ui_focus", "cloud_session_delta", "upgrade_relay_marker", "dev_intent", "code_change_published", "per_turn_effort_changed"]

function claudeCommandEvents(values: unknown): AgentRuntimeEvent[] {
  const listed = Array.isArray(values) ? values.flatMap((value) => {
    const row = asRecord(value)
    const name = text(row?.name) ?? text(value)
    return name ? [{ name, description: text(row?.description) ?? name }] : []
  }) : []
  return listed.length ? [{ type: "available-commands-update", commands: listed }] : []
}

function summaryDiagnostics(code: string, message: Record<string, unknown>, event: ClaudeFrameEvent): AgentRuntimeEvent[] {
  const summary = text(message.summary)
  return summary ? [diagnosticForEvent({ code, message: summary, severity: "info", event })] : []
}

function translateInit(message: Record<string, unknown>, state: ClaudeSdkAdapterState): ClaudeTranslation {
  const cwd = text(message.cwd)
  const model = text(message.model)
  return { state: { ...state, ...(cwd ? { cwd } : {}), ...(model ? { model } : {}) }, events: claudeCommandEvents(message.slash_commands) }
}

function compactionStatusEvents(message: Record<string, unknown>): AgentRuntimeEvent[] {
  if (message.status === "compacting") return [{ type: "session-status", status: "busy" }, { type: "session-compaction", phase: "started" }]
  if (message.compact_result !== "failed") return []
  return [{ type: "session-compaction", phase: "completed", metadata: { error: text(message.compact_error) ?? "Claude could not compact the conversation" } }]
}

function compacted(message: Record<string, unknown>): AgentRuntimeEvent[] {
  const metadata = asRecord(message.compact_metadata)
  return [{ type: "session-compaction", phase: "completed", ...(text(metadata?.trigger) ? { reason: text(metadata?.trigger) } : {}),
    metadata: { preTokens: asFiniteNumber(metadata?.pre_tokens), postTokens: asFiniteNumber(metadata?.post_tokens) } }]
}

function localOutput(content: string | undefined): AgentRuntimeEvent[] {
  return content ? [{ type: "text-delta", delta: content }] : []
}

function permissionDeniedEvents(toolCallId: string | undefined, error: string | undefined): AgentRuntimeEvent[] {
  return toolCallId ? [{ type: "tool-error", toolCallId, error: error ?? "Permission denied" }] : []
}

export function translateSystemMessage(message: Record<string, unknown>, state: ClaudeSdkAdapterState, event: ClaudeFrameEvent,
  memory: ClaudeTranslatorMemory): ClaudeTranslation {
  const subtype = text(message.subtype) ?? ""
  const notice = systemNotice(subtype, message)
  if (notice) return notice
  switch (subtype) {
    case "task_progress":
      return { state, events: summaryDiagnostics("claude_sdk.task_progress", message, event) }
    case "init":
      return translateInit(message, state)
    case "status":
      return compactionStatusEvents(message)
    case "compact_boundary":
      return compacted(message)
    case "local_command_output":
      return localOutput(text(message.content))
    case "commands_changed":
      return claudeCommandEvents(message.commands)
    case "permission_denied":
      return permissionDeniedEvents(text(message.tool_use_id), text(message.message))
    case "task_started":
    case "task_notification":
    case "background_tasks_changed":
    case "task_updated":
      return []
    default:
      return ignoredSubtypes.includes(subtype) ? [] : ignoredFrame(memory, `system/${subtype}`)
  }
}
