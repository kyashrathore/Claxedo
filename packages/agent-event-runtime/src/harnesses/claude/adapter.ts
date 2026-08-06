import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { AgentRuntimeEvent } from "../../contracts/agent-runtime-event"
import { runtimeDiagnostic } from "../../contracts/diagnostics"
import type { HarnessEventAdapter, HarnessEventAdapterContext, HarnessEventAdapterResult } from "../../core/adapter"
import { toolDisplayFromInput } from "../tool-display"
import { number, object, optionLabels, pathFields, text } from "../value"

type ClaudeBlockState = {
  type: "text" | "thinking" | "tool"
  fallbackText?: string
  emittedText?: boolean
  toolCallId?: string
  toolName?: string
  input?: Record<string, unknown>
  partialInputJson?: string
}

export type ClaudeSdkAdapterState = {
  blocksByIndex: Record<string, ClaudeBlockState>
  emittedAssistantText: string
  lastKnownContextWindow?: number
}

type ClaudeSdkSystemMessage = Extract<SDKMessage, { type: "system" }>

function assertNever(value: never): never {
  throw new Error(`Unhandled Claude SDK event: ${JSON.stringify(value)}`)
}

function payload(event: { payload: unknown }) {
  return object(event.payload) ?? {}
}

function sdkMessage(event: { payload: unknown }) {
  return payload(event)
}

const sdkMessageTypes = {
  assistant: true,
  auth_status: true,
  conversation_reset: true,
  prompt_suggestion: true,
  rate_limit_event: true,
  result: true,
  stream_event: true,
  system: true,
  tool_progress: true,
  tool_use_summary: true,
  user: true,
} satisfies Record<SDKMessage["type"], true>

function isSdkMessage(message: Record<string, unknown>): message is SDKMessage {
  return typeof message.type === "string" && message.type in sdkMessageTypes
}

function diagnosticForEvent(input: {
  code: string
  message: string
  event: { source: string; method?: string; payload: unknown }
  severity?: "debug" | "info" | "warn" | "error"
  details?: Record<string, unknown>
}) {
  return {
    type: "diagnostic",
    diagnostic: runtimeDiagnostic({
      code: input.code,
      message: input.message,
      severity: input.severity,
      source: input.event.source,
      method: input.event.method,
      raw: input.event.payload,
      details: input.details,
    }),
  } satisfies AgentRuntimeEvent
}

function unmappedSdkEvent(input: {
  sdkEvent: string
  reason: string
  event: { source: string; method?: string; payload: unknown }
  severity?: "debug" | "info" | "warn" | "error"
}) {
  return [diagnosticForEvent({
    code: "claude_sdk.unmapped_event",
    message: `${input.sdkEvent}: ${input.reason}`,
    severity: input.severity ?? "info",
    event: input.event,
    details: { sdkEvent: input.sdkEvent, reason: input.reason },
  })]
}

function toolInput(value: unknown) {
  return object(value) ?? {}
}

function isTodoTool(toolName: string) {
  return toolName.toLowerCase().includes("todowrite")
}

function isTaskTool(toolName: string) {
  return ["agent", "task"].includes(toolName.toLowerCase())
}

function todoStatus(value: unknown) {
  return value === "completed" ? "completed" : value === "in_progress" ? "in_progress" : "pending"
}

function todosFromInput(input: Record<string, unknown>) {
  const todos = Array.isArray(input.todos) ? input.todos : []
  return todos.flatMap((todo, i) => {
    const row = object(todo)
    if (!row) return []
    return [{
      id: String(i),
      description: text(row.content)?.trim() || text(row.description)?.trim() || "Task",
      status: todoStatus(row.status),
      priority: text(row.priority) ?? "medium",
    }]
  })
}

function parseJsonRecord(value: string) {
  try {
    return object(JSON.parse(value))
  } catch {
    return undefined
  }
}

function toolKind(toolName: string) {
  const normalized = toolName.toLowerCase()
  if (isTaskTool(toolName)) return "collab_agent_tool_call"
  if (normalized === "bash" || normalized.includes("shell") || normalized.includes("command")) return "command_execution"
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("patch")) return "file_change"
  if (normalized.includes("read") || normalized.includes("grep") || normalized.includes("glob")) return "file_read"
  return "dynamic_tool_call"
}

function toolDisplay(toolName: string, input: Record<string, unknown>) {
  return toolDisplayFromInput({
    kind: toolKind(toolName),
    toolName,
    ...(Object.keys(input).length ? { input } : {}),
  })
}

function toolStartEvents(block: Record<string, unknown>): AgentRuntimeEvent[] {
  const toolCallId = text(block.id)
  const toolName = text(block.name)
  if (!toolCallId || !toolName || isTodoTool(toolName)) return []
  const input = toolInput(block.input)
  const metadata = { claude: { itemType: toolKind(toolName) } }
  const display = toolDisplay(toolName, input)
  return [
    {
      type: "tool-start",
      toolCallId,
      toolName,
      kind: toolKind(toolName),
      display,
      metadata,
    },
    ...(Object.keys(input).length > 0
      ? [{ type: "tool-input", toolCallId, input, display, metadata } satisfies AgentRuntimeEvent]
      : []),
  ]
}

function toolInputEvents(tool: ClaudeBlockState, parsedInput: Record<string, unknown>) {
  if (!tool.toolCallId || !tool.toolName) return []
  if (isTodoTool(tool.toolName)) {
    const todos = todosFromInput(parsedInput)
    return todos.length ? [{ type: "todo-update", todos } satisfies AgentRuntimeEvent] : []
  }
  return [{
    type: "tool-input",
    toolCallId: tool.toolCallId,
    input: parsedInput,
    display: toolDisplay(tool.toolName, parsedInput),
    metadata: { claude: { itemType: toolKind(tool.toolName) } },
  }] satisfies AgentRuntimeEvent[]
}

function toolResultText(block: Record<string, unknown>) {
  const content = block.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.flatMap((item) => text(item) ?? text(object(item)?.text) ?? []).join("\n")
}

function toolResultBlocks(message: Record<string, unknown>) {
  const row = object(message.message) ?? {}
  const content = Array.isArray(row.content) ? row.content : []
  return content.flatMap((item) => {
    const block = object(item)
    if (!block || block.type !== "tool_result") return []
    const toolCallId = text(block.tool_use_id)
    if (!toolCallId) return []
    return [{
      toolCallId,
      block,
      text: toolResultText(block),
      isError: block.is_error === true,
    }]
  })
}

function assistantSnapshotText(message: Record<string, unknown>) {
  const row = object(message.message) ?? {}
  const content = Array.isArray(row.content) ? row.content : []
  return content.flatMap((item) => {
    const block = object(item)
    if (!block || block.type !== "text") return []
    return text(block.text) ?? []
  }).join("")
}

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

function usageSnapshot(message: Record<string, unknown>, lastKnownContextWindow?: number) {
  const usage = object(message.usage)
  if (!usage) return undefined
  const inputTokens =
    (number(usage.input_tokens) ?? 0) +
    (number(usage.cache_creation_input_tokens) ?? 0) +
    (number(usage.cache_read_input_tokens) ?? 0)
  const outputTokens = number(usage.output_tokens) ?? 0
  const totalTokens = number(usage.total_tokens) ?? inputTokens + outputTokens
  const modelUsage = object(message.modelUsage)
  const contextWindow = modelUsage
    ? Object.values(modelUsage).flatMap((value) => number(object(value)?.contextWindow) ?? [])[0]
    : undefined
  const contextSize = contextWindow ?? lastKnownContextWindow ?? totalTokens
  return {
    type: "usage",
    contextSize,
    contextUsed: Math.min(totalTokens, contextSize),
  } satisfies AgentRuntimeEvent
}

function isInterruptedResult(message: Record<string, unknown>, errorMessage?: string) {
  const summary = [
    errorMessage,
    text(message.subtype),
    text(message.stop_reason),
    text(message.result),
  ].flatMap((item) => item ?? []).join(" ").toLowerCase()
  return ["request was aborted", "aborted", "cancelled", "canceled", "interrupted"].some((item) => summary.includes(item))
}

function resultEvents(message: Record<string, unknown>, context: HarnessEventAdapterContext, lastKnownContextWindow?: number) {
  const usage = usageSnapshot(message, lastKnownContextWindow)
  const sessionId = text(message.session_id) ?? context.threadId
  const errors = Array.isArray(message.errors)
    ? message.errors.filter((item): item is string => typeof item === "string")
    : []
  const errorMessage = errors[0] ?? text(message.error)
  const interrupted = isInterruptedResult(message, errorMessage)
  if (message.is_error === true && !interrupted) {
    return [
      ...(usage ? [usage] : []),
      { type: "session-status", status: "error" },
      { type: "error", error: errorMessage ?? "Claude turn failed" },
    ] satisfies AgentRuntimeEvent[]
  }
  if (interrupted) {
    return [
      ...(usage ? [usage] : []),
      { type: "session-status", status: "idle" },
    ] satisfies AgentRuntimeEvent[]
  }
  return [
    ...(usage ? [usage] : []),
    { type: "session-status", status: "idle" },
    { type: "finish", sessionId },
  ] satisfies AgentRuntimeEvent[]
}

function questionFromToolUse(message: Record<string, unknown>, context: HarnessEventAdapterContext) {
  const row = payload({ payload: message })
  const toolName = text(row.toolName) ?? text(row.name)
  if (toolName !== "AskUserQuestion") return []
  const input = object(row.input) ?? row
  const prompt = text(input.question) ?? text(input.prompt)
  if (!prompt) return []
  const options = optionLabels(input.options)
  return [{
    type: "question",
    requestId: text(row.requestId) ?? context.createId("question"),
    questions: [{ text: prompt, ...(options?.length ? { options } : {}) }],
  }] satisfies AgentRuntimeEvent[]
}

function pathsFromToolInput(input: Record<string, unknown>) {
  return pathFields(input, ["path", "file_path", "filePath", "cwd"])
}

function permissionFromToolUse(message: Record<string, unknown>, context: HarnessEventAdapterContext) {
  const row = payload({ payload: message })
  const toolName = text(row.toolName) ?? text(row.name)
  if (!toolName) return []
  const input = object(row.input) ?? {}
  return [{
    type: "permission-request",
    requestId: text(row.requestId) ?? context.createId("permission"),
    tool: toolName,
    paths: pathsFromToolInput(input),
  }] satisfies AgentRuntimeEvent[]
}

export function claudeSdkAdapter(): HarnessEventAdapter<ClaudeSdkAdapterState> {
  return {
    name: "claude-sdk",
    createInitialState: () => ({ blocksByIndex: {}, emittedAssistantText: "" }),
    translate({ state, event, context }) {
      const rawMessage = sdkMessage(event)

      if (event.method === "claude/can-use-tool") {
        const questions = questionFromToolUse(rawMessage, context)
        return questions.length ? questions : permissionFromToolUse(rawMessage, context)
      }

      if (!isSdkMessage(rawMessage)) {
        return unmappedSdkEvent({
          sdkEvent: `SDKMessage(${text(rawMessage.type) ?? "unknown"})`,
          reason: "payload is not a known Claude SDK message type",
          event,
          severity: "warn",
        })
      }

      const message = rawMessage

      switch (message.type) {
        case "stream_event": {
          const stream = message.event
          switch (stream.type) {
            case "content_block_start": {
              const index = String(stream.index)
              const block = stream.content_block
              switch (block.type) {
                case "text":
                  return {
                    state: {
                      ...state,
                      blocksByIndex: {
                        ...state.blocksByIndex,
                        [index]: { type: "text", fallbackText: text(block.text) },
                      },
                    },
                    events: [],
                  }
                case "thinking":
                  return {
                    state: {
                      ...state,
                      blocksByIndex: {
                        ...state.blocksByIndex,
                        [index]: { type: "thinking", fallbackText: text(block.thinking) },
                      },
                    },
                    events: [],
                  }
                case "tool_use":
                case "server_tool_use":
                case "mcp_tool_use": {
                  const blockRow = object(block) ?? {}
                  const toolName = text(block.name)
                  const toolCallId = text(block.id)
                  if (!toolName || !toolCallId) return []
                  const input = toolInput(blockRow.input)
                  const nextTool = {
                    type: "tool" as const,
                    toolCallId,
                    toolName,
                    input,
                    partialInputJson: "",
                  }
                  const todoEvents = isTodoTool(toolName) ? toolInputEvents(nextTool, input) : []
                  return {
                    state: {
                      ...state,
                      blocksByIndex: { ...state.blocksByIndex, [index]: nextTool },
                    },
                    events: [...toolStartEvents(blockRow), ...todoEvents],
                  }
                }
                case "redacted_thinking":
                  return unmappedSdkEvent({
                    sdkEvent: "SDKPartialAssistantMessage.content_block_start(redacted_thinking)",
                    reason: "redacted thinking cannot be represented as assistant thinking text",
                    event,
                  })
                case "web_search_tool_result":
                case "web_fetch_tool_result":
                case "advisor_tool_result":
                case "code_execution_tool_result":
                case "bash_code_execution_tool_result":
                case "text_editor_code_execution_tool_result":
                case "tool_search_tool_result":
                case "mcp_tool_result":
                case "container_upload":
                  return unmappedSdkEvent({
                    sdkEvent: `SDKPartialAssistantMessage.content_block_start(${block.type})`,
                    reason: "provider result block has no stable AgentRuntimeEvent mapping without a tool-use id",
                    event,
                  })
                case "compaction":
                  return unmappedSdkEvent({
                    sdkEvent: "SDKPartialAssistantMessage.content_block_start(compaction)",
                    reason: "streaming compaction content has no stable AgentRuntimeEvent mapping yet",
                    event,
                  })
                case "fallback":
                  return unmappedSdkEvent({
                    sdkEvent: "SDKPartialAssistantMessage.content_block_start(fallback)",
                    reason: "model fallback boundaries have no dedicated AgentRuntimeEvent equivalent",
                    event,
                  })
                default:
                  return assertNever(block)
              }
            }
            case "content_block_delta": {
              const row = stream.delta
              switch (row.type) {
                case "text_delta": {
                  const deltaText = text(row.text)
                  if (!deltaText) return []
                  const block = state.blocksByIndex[String(stream.index)]
                  return {
                    state: {
                      ...state,
                      emittedAssistantText: `${state.emittedAssistantText}${deltaText}`,
                      blocksByIndex: block
                        ? { ...state.blocksByIndex, [String(stream.index)]: { ...block, emittedText: true } }
                        : state.blocksByIndex,
                    },
                    events: [{ type: "text-delta", delta: deltaText }],
                  }
                }
                case "thinking_delta": {
                  const thinking = text(row.thinking)
                  if (!thinking) return []
                  const block = state.blocksByIndex[String(stream.index)]
                  return {
                    state: {
                      ...state,
                      blocksByIndex: block
                        ? { ...state.blocksByIndex, [String(stream.index)]: { ...block, emittedText: true } }
                        : state.blocksByIndex,
                    },
                    events: [{ type: "thinking-delta", delta: thinking }],
                  }
                }
                case "input_json_delta": {
                  const block = state.blocksByIndex[String(stream.index)]
                  const partial = text(row.partial_json)
                  if (!block || block.type !== "tool" || !partial) return []
                  const partialInputJson = `${block.partialInputJson ?? ""}${partial}`
                  const parsedInput = parseJsonRecord(partialInputJson)
                  const nextBlock = {
                    ...block,
                    partialInputJson,
                    ...(parsedInput ? { input: parsedInput } : {}),
                  }
                  return {
                    state: {
                      ...state,
                      blocksByIndex: { ...state.blocksByIndex, [String(stream.index)]: nextBlock },
                    },
                    events: parsedInput ? toolInputEvents(nextBlock, parsedInput) : [],
                  }
                }
                case "citations_delta":
                case "signature_delta":
                case "compaction_delta":
                  return unmappedSdkEvent({
                    sdkEvent: `SDKPartialAssistantMessage.content_block_delta(${row.type})`,
                    reason: "delta type has no dedicated AgentRuntimeEvent equivalent",
                    event,
                  })
                default:
                  return assertNever(row)
              }
            }
            case "content_block_stop": {
              const index = String(stream.index)
              const block = state.blocksByIndex[index]
              if (block?.type === "text" && block.fallbackText && !block.emittedText) {
                return {
                  state: {
                    ...state,
                    emittedAssistantText: `${state.emittedAssistantText}${block.fallbackText}`,
                    blocksByIndex: { ...state.blocksByIndex, [index]: { ...block, emittedText: true } },
                  },
                  events: [{ type: "text-delta", delta: block.fallbackText }],
                }
              }
              if (block?.type === "thinking" && block.fallbackText && !block.emittedText) {
                return {
                  state: {
                    ...state,
                    blocksByIndex: { ...state.blocksByIndex, [index]: { ...block, emittedText: true } },
                  },
                  events: [{ type: "thinking-delta", delta: block.fallbackText }],
                }
              }
              return []
            }
            case "message_start":
            case "message_delta":
            case "message_stop":
              return []
            default:
              return assertNever(stream)
          }
        }

        case "user": {
          const byToolId = Object.fromEntries(
            Object.values(state.blocksByIndex).flatMap((block) =>
              block.type === "tool" && block.toolCallId ? [[block.toolCallId, block]] : [],
            ),
          )
          return toolResultBlocks(rawMessage).flatMap((result): AgentRuntimeEvent[] => {
            const tool = byToolId[result.toolCallId]
            if (!tool?.toolName) return []
            const metadata = { claude: { itemType: toolKind(tool.toolName) } }
            const display = toolDisplay(tool.toolName, tool.input ?? {})
            if (result.isError) {
              return [{ type: "tool-error", toolCallId: result.toolCallId, error: result.text, display, metadata }]
            }
            return [{ type: "tool-output", toolCallId: result.toolCallId, output: result.text, display, metadata }]
          })
        }

        case "assistant": {
          if (message.error) {
            return [
              { type: "session-status", status: "error" },
              { type: "error", error: `Claude assistant message failed: ${message.error}` },
            ] satisfies AgentRuntimeEvent[]
          }
          const snapshot = assistantSnapshotText(rawMessage)
          if (!snapshot) return []
          const deltaText = snapshot.startsWith(state.emittedAssistantText)
            ? snapshot.slice(state.emittedAssistantText.length)
            : state.emittedAssistantText.endsWith(snapshot)
              ? ""
              : snapshot
          if (!deltaText) return []
          return {
            state: { ...state, emittedAssistantText: snapshot },
            events: [{ type: "text-delta", delta: deltaText }],
          }
        }

        case "result": {
          const usage = usageSnapshot(rawMessage, state.lastKnownContextWindow)
          const nextContextWindow = usage?.contextSize ?? state.lastKnownContextWindow
          return {
            state: {
              ...state,
              blocksByIndex: {},
              emittedAssistantText: "",
              ...(nextContextWindow ? { lastKnownContextWindow: nextContextWindow } : {}),
            },
            events: resultEvents(rawMessage, context, state.lastKnownContextWindow),
          }
        }

        case "system":
          return translateSystemMessage(message, rawMessage, state, event)

        case "tool_progress":
          return [{ type: "tool-status", toolCallId: message.tool_use_id, status: "running" }]

        case "tool_use_summary":
          return message.summary ? [{ type: "diagnostic", diagnostic: runtimeDiagnostic({
            code: "claude_sdk.tool_use_summary",
            message: message.summary,
            severity: "info",
            source: event.source,
            method: event.method,
            raw: event.payload,
          }) }] : []

        case "auth_status":
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

        case "rate_limit_event":
          return unmappedSdkEvent({
            sdkEvent: "SDKRateLimitEvent",
            reason: "rate limit metadata has no dedicated AgentRuntimeEvent equivalent",
            event,
          })

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
    },
  }
}

function translateSystemMessage(
  message: ClaudeSdkSystemMessage,
  rawMessage: Record<string, unknown>,
  state: ClaudeSdkAdapterState,
  event: { source: string; method?: string; payload: unknown },
): HarnessEventAdapterResult<ClaudeSdkAdapterState> | AgentRuntimeEvent[] {
  switch (message.subtype) {
    case "task_progress": {
      const usage = usageSnapshot({ usage: rawMessage.usage }, state.lastKnownContextWindow)
      return {
        state: {
          ...state,
          ...(usage ? { lastKnownContextWindow: usage.contextSize } : {}),
        },
        events: [
          ...(usage ? [usage] : []),
          ...(text(rawMessage.summary)
            ? [{
              type: "diagnostic",
              diagnostic: runtimeDiagnostic({
                code: "claude_sdk.task_progress",
                message: text(rawMessage.summary)!,
                severity: "info",
                source: event.source,
                method: event.method,
                raw: event.payload,
              }),
            } satisfies AgentRuntimeEvent]
            : []),
        ],
      }
    }

    case "init":
      return [
        ...slashCommandEvents(rawMessage),
        ...unmappedSdkEvent({
          sdkEvent: "SDKSystemMessage(init)",
          reason: "cwd, model, tools, MCP server status, permission mode, and output style have no complete AgentRuntimeEvent mapping",
          event,
        }),
      ]

    case "compact_boundary":
      return unmappedSdkEvent({
        sdkEvent: "SDKCompactBoundaryMessage",
        reason: "compaction metadata has no dedicated AgentRuntimeEvent equivalent",
        event,
      })

    case "status":
      return message.status === "compacting"
        ? [{ type: "session-status", status: "busy" }]
        : []

    case "local_command_output":
      return message.content ? [{ type: "text-delta", delta: message.content }] : []

    case "hook_started":
    case "hook_progress":
    case "hook_response":
      return unmappedSdkEvent({
        sdkEvent: `SDKSystemMessage(${message.subtype})`,
        reason: "hook lifecycle output has no dedicated AgentRuntimeEvent equivalent",
        event,
      })

    case "task_started":
      return unmappedSdkEvent({
        sdkEvent: "SDKTaskStartedMessage",
        reason: "subagent lifecycle observations are admitted by the host boundary",
        event,
      })

    case "task_notification":
      if (message.tool_use_id && message.status === "failed") {
        return [{ type: "tool-error", toolCallId: message.tool_use_id, error: message.summary }]
      }
      if (message.tool_use_id) {
        return [{ type: "tool-status", toolCallId: message.tool_use_id, status: "completed" }]
      }
      return unmappedSdkEvent({
        sdkEvent: "SDKTaskNotificationMessage",
        reason: "task notification without a parent tool use has no dedicated AgentRuntimeEvent equivalent",
        event,
      })

    case "files_persisted":
      return unmappedSdkEvent({
        sdkEvent: "SDKFilesPersistedEvent",
        reason: "file persistence metadata has no dedicated AgentRuntimeEvent equivalent",
        event,
      })

    case "elicitation_complete":
      return unmappedSdkEvent({
        sdkEvent: "SDKElicitationCompleteMessage",
        reason: "MCP elicitation completion has no dedicated AgentRuntimeEvent equivalent",
        event,
      })

    case "commands_changed":
      return [{
        type: "available-commands-update",
        commands: message.commands.map((command) => ({
          name: command.name,
          description: command.description,
        })),
      }]

    case "permission_denied":
      return [{ type: "tool-error", toolCallId: message.tool_use_id, error: message.message }]

    case "api_retry":
    case "background_tasks_changed":
    case "control_request_progress":
    case "informational":
    case "memory_recall":
    case "mirror_error":
    case "model_refusal_fallback":
    case "model_refusal_no_fallback":
    case "notification":
    case "plugin_install":
    case "session_state_changed":
    case "task_updated":
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
