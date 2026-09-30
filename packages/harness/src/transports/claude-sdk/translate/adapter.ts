import { asText as text } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { HarnessEventAdapter, HarnessEventAdapterContext } from "../../../translate/adapter"
import type { ClaudeSdkAdapterState, ClaudeTranslation } from "./adapter-state"
import { translateAssistantMessage } from "./assistant-message"
import { translateCanUseTool } from "./can-use-tool"
import { translateRateLimitEvent } from "./rate-limits"
import { CLAUDE_SUBAGENT_USAGE_METHOD, translateMessageDelta, translateMessageStart, translateMessageStop, translateSubagentUsage } from "./request-stream"
import { translateResult } from "./result-events"
import { assertNever, diagnosticForEvent, isSdkMessage, sdkMessage, unmappedSdkEvent, type ClaudeFrameEvent, type ClaudeSdkStreamEvent } from "./sdk-message"
import { translateContentBlockDelta, translateContentBlockStart, translateContentBlockStop } from "./stream-content"
import { translateSystemMessage } from "./system-message"
import type { ClaudeTrackedTask } from "./task-tracking"
import { translateToolResults } from "./tool-results"
import { claudeTranscriptTitle } from "./transcript-title"

type AuthStatusMessage = Extract<SDKMessage, { type: "auth_status" }>

export function claudeSdkAdapter(initialTasks: ClaudeTrackedTask[] = []): HarnessEventAdapter<ClaudeSdkAdapterState> {
  return {
    name: "claude-sdk",
    createInitialState: () => ({ blocksByIndex: {}, toolsById: {}, streamedAssistantTextByOwner: {}, reconciledAssistantTextByMessageId: {}, tasks: Object.fromEntries(initialTasks.map((task) => [task.id, task])) }),
    translate: ({ state, event, context }) => translateClaudeFrame(state, event, context),
  }
}

function translateClaudeFrame(state: ClaudeSdkAdapterState, event: ClaudeFrameEvent, context: HarnessEventAdapterContext): ClaudeTranslation {
  const rawMessage = sdkMessage(event)
  if (event.method === "claude/can-use-tool") return translateCanUseTool(rawMessage, context)
  if (event.method === "claude/session-store") return claudeTranscriptTitle(rawMessage)
  if (event.method === CLAUDE_SUBAGENT_USAGE_METHOD) return translateSubagentUsage(state, rawMessage)
  if (!isSdkMessage(rawMessage)) {
    return unmappedSdkEvent({
      sdkEvent: `SDKMessage(${text(rawMessage.type) ?? "unknown"})`,
      reason: "payload is not a known Claude SDK message type",
      event,
      severity: "warn",
    })
  }
  return translateClaudeSdkMessage(rawMessage, rawMessage, state, event, context)
}

function translateClaudeSdkMessage(
  message: SDKMessage,
  rawMessage: Record<string, unknown>,
  state: ClaudeSdkAdapterState,
  event: ClaudeFrameEvent,
  context: HarnessEventAdapterContext,
): ClaudeTranslation {
  switch (message.type) {
    case "stream_event":
      return translateStreamEvent(message.event, rawMessage, state, event)
    case "user":
      return translateToolResults(state, rawMessage)
    case "assistant":
      return translateAssistantMessage(message, rawMessage, state, event)
    case "result":
      return translateResult(state, rawMessage, context)
    case "system":
      return translateSystemMessage(message, rawMessage, state, event)
    case "tool_progress":
      return [{ type: "tool-status", toolCallId: message.tool_use_id, status: "running" }]
    case "tool_use_summary":
      return message.summary ? [diagnosticForEvent({ code: "claude_sdk.tool_use_summary", message: message.summary, severity: "info", event })] : []
    case "auth_status":
      return authStatusEvents(message, event)
    case "rate_limit_event":
      return translateRateLimitEvent(state, message.rate_limit_info)
    case "prompt_suggestion":
      return unmappedSdkEvent({
        sdkEvent: "SDKPromptSuggestionMessage",
        reason: "prompt suggestions have no dedicated AgentRuntimeEvent equivalent",
        event,
      })
    case "conversation_reset":
      return unmappedSdkEvent({
        sdkEvent: "SDKConversationResetMessage",
        reason: "conversation reset has no dedicated AgentRuntimeEvent equivalent",
        event,
      })
    default:
      return assertNever(message)
  }
}

function translateStreamEvent(
  stream: ClaudeSdkStreamEvent,
  rawMessage: Record<string, unknown>,
  state: ClaudeSdkAdapterState,
  event: ClaudeFrameEvent,
): ClaudeTranslation {
  switch (stream.type) {
    case "content_block_start":
      return translateContentBlockStart(stream, state, event)
    case "content_block_delta":
      return translateContentBlockDelta(stream, rawMessage, state, event)
    case "content_block_stop":
      return translateContentBlockStop(String(stream.index), rawMessage, state)
    case "message_start":
      return translateMessageStart(stream, rawMessage, state)
    case "message_delta":
      return translateMessageDelta(stream, rawMessage, state)
    case "message_stop":
      return translateMessageStop(rawMessage, state)
    default:
      return assertNever(stream)
  }
}

function authStatusEvents(message: AuthStatusMessage, event: ClaudeFrameEvent): AgentRuntimeEvent[] {
  return message.error
    ? [
      { type: "session-status", status: "error" },
      { type: "error", error: message.error },
    ] satisfies AgentRuntimeEvent[]
    : unmappedSdkEvent({
      sdkEvent: "SDKAuthStatusMessage",
      reason: "authentication progress output has no dedicated AgentRuntimeEvent equivalent",
      event,
    })
}
