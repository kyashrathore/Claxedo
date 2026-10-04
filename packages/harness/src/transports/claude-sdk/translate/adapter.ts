import { asText as text, type AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asRecordOrEmpty } from "@claxedo/helpers/guards"
import type { HarnessEventAdapter, HarnessEventAdapterContext } from "../../../translate/adapter"
import type { ClaudeSdkAdapterState, ClaudeTranslation } from "./adapter-state"
import { translateAssistantMessage } from "./assistant-message"
import { translateRateLimitEvent } from "./rate-limits"
import { CLAUDE_SUBAGENT_USAGE_METHOD, translateMessageDelta, translateMessageStart, translateMessageStop, translateSubagentUsage } from "./request-stream"
import { translateResult } from "./result-events"
import { diagnosticForEvent, ignoredFrame, isClaudeAssistantMessage, isClaudeStreamEvent, isClaudeStreamEventKind, malformedFrame,
  type ClaudeFrameEvent, type ClaudeSdkStreamEvent } from "./sdk-message"
import { translateContentBlockDelta, translateContentBlockStart, translateContentBlockStop } from "./stream-content"
import { translateSystemMessage } from "./system-message"
import type { ClaudeTrackedTask } from "./task-tracking"
import { translateToolResults } from "./tool-results"
import { claudeAgentMessage } from "./child-messages"
import { createClaudeTranslatorMemory, type ClaudeTranslatorMemory } from "./translator-memory"

type Frame = { message: Record<string, unknown>; state: ClaudeSdkAdapterState; event: ClaudeFrameEvent; context: HarnessEventAdapterContext;
  memory: ClaudeTranslatorMemory }

const ignoredTypes: readonly string[] = ["tool_progress", "prompt_suggestion", "command_lifecycle", "tombstone"]

export function claudeSdkAdapter(initialTasks: ClaudeTrackedTask[] = [], memory = createClaudeTranslatorMemory()): HarnessEventAdapter<ClaudeSdkAdapterState> {
  return {
    name: "claude-sdk",
    createInitialState: () => ({ blocksByIndex: {}, toolsById: {}, streamedAssistantTextByOwner: {}, streamedThinkingByOwner: {},
      ...(memory.window ? { model: memory.window.model } : {}), tasks: Object.fromEntries(initialTasks.map((task) => [task.id, task])) }),
    translate: ({ state, event, context }) => translateClaudeFrame({ message: asRecordOrEmpty(event.payload), state, event, context, memory }),
  }
}

function translateClaudeFrame(frame: Frame): ClaudeTranslation {
  const { message, state, event, context, memory } = frame
  if (event.method === CLAUDE_SUBAGENT_USAGE_METHOD) return translateSubagentUsage(state, memory, message)
  const type = text(message.type) ?? "unknown"
  if (ignoredTypes.includes(type)) return []
  switch (type) {
    case "stream_event":
      return translateStreamFrame(message.event, frame)
    case "user": {
      return claudeAgentMessage(message, event) ?? translateToolResults(state, message)
    }
    case "assistant":
      return isClaudeAssistantMessage(message) ? translateAssistantMessage(message, message, state, event, memory) : malformedFrame(event, type)
    case "result":
      return translateResult(state, message, context, memory)
    case "system":
      return translateSystemMessage(message, state, event, memory)
    case "tool_use_summary":
      return text(message.summary) ? [diagnosticForEvent({ code: "claude_sdk.tool_use_summary", message: text(message.summary) ?? "", severity: "info", event })] : []
    case "auth_status":
      return authStatusEvents(message)
    case "rate_limit_event":
      return translateRateLimitEvent(state, message.rate_limit_info)
    case "conversation_reset":
      return [{ type: "conversation-reset", trigger: text(message.trigger) ?? "unspecified" }]
    default:
      return ignoredFrame(memory, type)
  }
}

function translateStreamFrame(raw: unknown, frame: Frame): ClaudeTranslation {
  if (isClaudeStreamEvent(raw)) return translateStreamEvent(raw, frame)
  const kind = text(asRecordOrEmpty(raw).type)
  if (kind === "ping") return []
  return isClaudeStreamEventKind(kind) ? malformedFrame(frame.event, `stream_event/${kind}`) : ignoredFrame(frame.memory, `stream_event/${kind ?? "undefined"}`)
}

function translateStreamEvent(stream: ClaudeSdkStreamEvent, frame: Frame): ClaudeTranslation {
  const { message, state, memory } = frame
  switch (stream.type) {
    case "content_block_start":
      return translateContentBlockStart(stream, state, memory)
    case "content_block_delta":
      return translateContentBlockDelta(stream, message, state, memory)
    case "content_block_stop":
      return translateContentBlockStop(String(stream.index), message, state)
    case "message_start":
      return translateMessageStart(stream, message, state, memory)
    case "message_delta":
      return translateMessageDelta(stream, message, state, memory)
    case "message_stop":
    default:
      return translateMessageStop(message, state)
  }
}

function authStatusEvents(message: Record<string, unknown>): AgentRuntimeEvent[] {
  const error = text(message.error)
  return error ? [{ type: "auth-status", status: "unauthenticated", metadata: { error } }] : []
}
