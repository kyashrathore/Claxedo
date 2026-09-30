import { asText as text } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { ClaudeSdkAdapterState, ClaudeTranslation } from "./adapter-state"
import { assertNever, diagnosticForEvent, unmappedSdkEvent, type ClaudeFrameEvent, type ClaudeSdkSystemMessage } from "./sdk-message"

type MappedSystemSubtype =
  | "task_progress"
  | "init"
  | "status"
  | "local_command_output"
  | "commands_changed"
  | "permission_denied"
  | "task_started"
  | "task_notification"
  | "background_tasks_changed"
  | "task_updated"

type UnmappedSystemMessage = Exclude<ClaudeSdkSystemMessage, { subtype: MappedSystemSubtype }>

const namedUnmappedSystemMessages = {
  compact_boundary: { sdkEvent: "SDKCompactBoundaryMessage", reason: "compaction metadata has no dedicated AgentRuntimeEvent equivalent" },
  files_persisted: { sdkEvent: "SDKFilesPersistedEvent", reason: "file persistence metadata has no dedicated AgentRuntimeEvent equivalent" },
  elicitation_complete: { sdkEvent: "SDKElicitationCompleteMessage", reason: "MCP elicitation completion has no dedicated AgentRuntimeEvent equivalent" },
} as const

function slashCommandEvents(message: Record<string, unknown>) {
  const commands = Array.isArray(message.slash_commands)
    ? message.slash_commands.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []
  return commands.length
    ? [{
      type: "available-commands-update",
      commands: commands.map((command) => ({ name: command, description: command })),
    } satisfies AgentRuntimeEvent]
    : []
}

function summaryDiagnostics(code: string, message: Record<string, unknown>, event: ClaudeFrameEvent): AgentRuntimeEvent[] {
  const summary = text(message.summary)
  return summary ? [diagnosticForEvent({ code, message: summary, severity: "info", event })] : []
}

function translateInit(message: Record<string, unknown>, state: ClaudeSdkAdapterState, event: ClaudeFrameEvent): ClaudeTranslation {
  const cwd = text(message.cwd)
  return {
    ...(cwd ? { state: { ...state, cwd } } : {}),
    events: [
      ...slashCommandEvents(message),
      ...unmappedSdkEvent({
        sdkEvent: "SDKSystemMessage(init)",
        reason: "model, tools, MCP server status, permission mode, and output style have no complete AgentRuntimeEvent mapping",
        event,
      }),
    ],
  }
}

function unmappedSystemMessage(message: UnmappedSystemMessage, event: ClaudeFrameEvent): AgentRuntimeEvent[] {
  switch (message.subtype) {
    case "compact_boundary":
    case "files_persisted":
    case "elicitation_complete":
      return unmappedSdkEvent({ ...namedUnmappedSystemMessages[message.subtype], event })
    case "hook_started":
    case "hook_progress":
    case "hook_response":
      return unmappedSdkEvent({
        sdkEvent: `SDKSystemMessage(${message.subtype})`,
        reason: "hook lifecycle output has no dedicated AgentRuntimeEvent equivalent",
        event,
      })
    case "api_retry":
    case "control_request_progress":
    case "informational":
    case "memory_recall":
    case "mirror_error":
    case "model_refusal_fallback":
    case "model_refusal_no_fallback":
    case "notification":
    case "plugin_install":
    case "session_state_changed":
    case "thinking_tokens":
    case "worker_shutting_down":
      return unmappedSdkEvent({
        sdkEvent: `SDKSystemMessage(${message.subtype})`,
        reason: "system metadata has no dedicated AgentRuntimeEvent equivalent",
        event,
      })
    default:
      return assertNever(message)
  }
}

export function translateSystemMessage(
  message: ClaudeSdkSystemMessage,
  rawMessage: Record<string, unknown>,
  state: ClaudeSdkAdapterState,
  event: ClaudeFrameEvent,
): ClaudeTranslation {
  if (text(rawMessage.subtype) === "post_turn_summary") return summaryDiagnostics("claude_sdk.post_turn_summary", rawMessage, event)
  switch (message.subtype) {
    case "task_progress":
      return { state, events: summaryDiagnostics("claude_sdk.task_progress", rawMessage, event) }
    case "init":
      return translateInit(rawMessage, state, event)
    case "status":
      return message.status === "compacting" ? [{ type: "session-status", status: "busy" }] : []
    case "local_command_output":
      return message.content ? [{ type: "text-delta", delta: message.content }] : []
    case "commands_changed":
      return [{
        type: "available-commands-update",
        commands: message.commands.map((command) => ({ name: command.name, description: command.description })),
      }]
    case "permission_denied":
      return [{ type: "tool-error", toolCallId: message.tool_use_id, error: message.message }]
    case "task_started":
    case "task_notification":
    case "background_tasks_changed":
    case "task_updated":
      return []
    default:
      return unmappedSystemMessage(message, event)
  }
}
