import type { LocalRunStreamEvent, SDKMessage } from "@cursor/sdk"
import type { AgentRuntimeEvent } from "../../contracts/agent-runtime-event"
import { runtimeDiagnostic } from "../../contracts/diagnostics"
import type { HarnessEventAdapter, HarnessEventAdapterContext, HarnessEventAdapterResult } from "../../core/adapter"
import { toolDisplayFromInput } from "../tool-display"
import { number, object, text } from "../value"

export type CursorSdkMessage = SDKMessage

export type CursorSdkAdapterState = {
  assistantTextByRunId: Record<string, string>
  thinkingTextByRunId: Record<string, string>
  toolsByCallId: Record<string, {
    toolName: string
    kind: string
    input?: Record<string, unknown>
  }>
}

function createCursorSdkAdapterState(): CursorSdkAdapterState {
  return { assistantTextByRunId: {}, thinkingTextByRunId: {}, toolsByCallId: {} }
}

function pruneTurnState() {
  return createCursorSdkAdapterState()
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Cursor SDK event: ${JSON.stringify(value)}`)
}

function payload(event: { payload: unknown }) {
  return object(event.payload) ?? {}
}

const sdkMessageTypes = {
  assistant: true,
  request: true,
  status: true,
  system: true,
  task: true,
  thinking: true,
  tool_call: true,
  user: true,
} satisfies Record<SDKMessage["type"], true>

const localRunStreamEventTypes = {
  done: true,
  result: true,
  sdk_message: true,
} satisfies Record<LocalRunStreamEvent["type"], true>

function isSdkMessage(value: unknown): value is SDKMessage {
  const message = object(value)
  return typeof message?.type === "string" && message.type in sdkMessageTypes
}

function isLocalRunStreamEvent(value: unknown): value is LocalRunStreamEvent {
  const message = object(value)
  return typeof message?.type === "string" && message.type in localRunStreamEventTypes
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
    code: "cursor_sdk.unmapped_event",
    message: `${input.sdkEvent}: ${input.reason}`,
    severity: input.severity ?? "info",
    event: input.event,
    details: { sdkEvent: input.sdkEvent, reason: input.reason },
  })]
}

function toolInput(value: unknown) {
  const input = object(value) ?? {}
  return text(input.workingDirectory) && !input.cwd
    ? { ...input, cwd: input.workingDirectory }
    : input
}

function isTodoTool(toolName: string) {
  return toolName.toLowerCase().includes("todo")
}

function isTaskTool(toolName: string) {
  return toolName.toLowerCase() === "task"
}

function cursorTodoStatus(value: unknown) {
  if (value === "completed") return "completed"
  if (value === "inProgress" || value === "in_progress") return "in_progress"
  return "pending"
}

function todosFromInput(input: Record<string, unknown>) {
  const todos = Array.isArray(input.todos) ? input.todos : []
  return todos.flatMap((todo, i) => {
    const row = object(todo)
    if (!row) return []
    return [{
      id: String(i),
      description: text(row.content)?.trim() || text(row.description)?.trim() || "Task",
      status: cursorTodoStatus(row.status),
    }]
  })
}

function toolKind(toolName: string) {
  const normalized = toolName.toLowerCase()
  if (isTaskTool(toolName)) return "collab_agent_tool_call"
  if (normalized === "shell" || normalized.includes("shell") || normalized.includes("command")) return "command_execution"
  if (normalized === "write" || normalized === "edit" || normalized === "delete" || normalized.includes("patch")) return "file_change"
  if (normalized === "read" || normalized === "readlints") return "file_read"
  if (normalized === "grep" || normalized === "glob" || normalized === "semsearch" || normalized.includes("search")) return "web_search"
  if (normalized === "mcp" || normalized.startsWith("mcp")) return "mcp_tool_call"
  if (normalized === "createplan" || normalized.includes("plan")) return "plan"
  if (normalized.includes("image")) return "image_view"
  return "dynamic_tool_call"
}

function toolDisplay(toolName: string, input: Record<string, unknown>) {
  return toolDisplayFromInput({
    kind: toolKind(toolName),
    toolName,
    ...(Object.keys(input).length ? { input } : {}),
  })
}

function subagentId(input: Record<string, unknown>, fallback: string) {
  const subagent = object(input.subagentType) ?? object(input.subagent_type)
  return text(subagent?.name) ?? text(subagent?.kind) ?? text(input.subagent_type) ?? text(input.mode) ?? fallback
}

function ensureTool(input: {
  state: CursorSdkAdapterState
  toolCallId: string
  toolName: string
  rawInput?: Record<string, unknown>
}) {
  const existing = input.state.toolsByCallId[input.toolCallId]
  const toolName = existing?.toolName ?? input.toolName
  const rawInput = existing?.input ?? input.rawInput
  const kind = existing?.kind ?? toolKind(toolName)
  const display = toolDisplay(toolName, rawInput ?? {})
  if (existing) {
    return {
      state: input.state,
      events: [] satisfies AgentRuntimeEvent[],
      toolName,
      rawInput,
      kind,
      display,
    }
  }
  return {
    state: {
      ...input.state,
      toolsByCallId: {
        ...input.state.toolsByCallId,
        [input.toolCallId]: {
          toolName,
          kind,
          ...(rawInput ? { input: rawInput } : {}),
        },
      },
    },
    events: [
      { type: "tool-start", toolCallId: input.toolCallId, toolName, kind, display, metadata: { cursor: { itemType: kind } } },
      ...(rawInput && Object.keys(rawInput).length
        ? [{ type: "tool-input", toolCallId: input.toolCallId, input: rawInput, display, metadata: { cursor: { itemType: kind } } } satisfies AgentRuntimeEvent]
        : []),
      ...(isTaskTool(toolName)
        ? [{ type: "subagent-spawned", childSessionId: subagentId(rawInput ?? {}, input.toolCallId) } satisfies AgentRuntimeEvent]
        : []),
    ] satisfies AgentRuntimeEvent[],
    toolName,
    rawInput,
    kind,
    display,
  }
}

function errorMessage(value: unknown) {
  const row = object(value)
  const nested = object(row?.error)
  return text(row?.message) ?? text(nested?.message) ?? text(row?.error) ?? text(value) ?? JSON.stringify(value)
}

function successfulOutput(value: unknown) {
  const row = object(value)
  if (row?.status === "success" && row.value !== undefined) return row.value
  return value
}

function isErrorResult(value: unknown) {
  const row = object(value)
  if (row?.status === "error") return true
  const nested = object(row?.value)
  const exitCode = number(nested?.exitCode)
  return exitCode !== undefined && exitCode !== 0
}

function toolCompletedEvents(input: {
  state: CursorSdkAdapterState
  toolCallId: string
  toolName: string
  rawInput: Record<string, unknown>
  result: unknown
  isError: boolean
}) {
  const ensured = ensureTool(input)
  if (isTodoTool(ensured.toolName)) return { state: ensured.state, events: ensured.events }
  if (input.isError || isErrorResult(input.result)) {
    return {
      state: ensured.state,
      events: [
        ...ensured.events,
        { type: "tool-error", toolCallId: input.toolCallId, error: errorMessage(input.result) ?? "Cursor tool failed", display: ensured.display, metadata: { cursor: { itemType: ensured.kind } } },
      ] satisfies AgentRuntimeEvent[],
    }
  }
  return {
    state: ensured.state,
    events: [
      ...ensured.events,
      { type: "tool-output", toolCallId: input.toolCallId, output: successfulOutput(input.result), display: ensured.display, metadata: { cursor: { itemType: ensured.kind } } },
    ] satisfies AgentRuntimeEvent[],
  }
}

function statusEvents(message: Extract<SDKMessage, { type: "status" }>, context: HarnessEventAdapterContext) {
  const status = message.status
  switch (status) {
    case "CREATING":
    case "RUNNING":
      return [{ type: "session-status", status: "busy" }] satisfies AgentRuntimeEvent[]
    case "FINISHED":
      return [
        { type: "session-status", status: "idle" },
        { type: "finish", sessionId: message.run_id || context.threadId },
      ] satisfies AgentRuntimeEvent[]
    case "CANCELLED":
      return [{ type: "session-status", status: "idle" }] satisfies AgentRuntimeEvent[]
    case "ERROR":
    case "EXPIRED":
      return [
        { type: "session-status", status: "error" },
        { type: "error", error: message.message ?? `Cursor run ${status.toLowerCase()}` },
      ] satisfies AgentRuntimeEvent[]
    default:
      return assertNever(status)
  }
}

function isTerminalSdkStatus(status: Extract<SDKMessage, { type: "status" }>["status"]) {
  return status === "FINISHED" || status === "CANCELLED" || status === "ERROR" || status === "EXPIRED"
}

function localRunTerminalEvents(
  row: Exclude<LocalRunStreamEvent, { type: "sdk_message" }>,
  context: HarnessEventAdapterContext,
): AgentRuntimeEvent[] {
  switch (row.type) {
    case "result": {
      const status = row.status
      switch (status) {
        case "finished":
          return [
            { type: "session-status", status: "idle" },
            { type: "finish", sessionId: row.runId },
          ] satisfies AgentRuntimeEvent[]
        case "cancelled":
          return [{ type: "session-status", status: "idle" }] satisfies AgentRuntimeEvent[]
        case "error":
          return [
            { type: "session-status", status: "error" },
            { type: "error", error: row.errorCode ?? "Cursor run failed" },
          ] satisfies AgentRuntimeEvent[]
        default:
          return assertNever(status)
      }
    }
    case "done":
      return [
        { type: "session-status", status: "idle" },
        { type: "finish", sessionId: row.runId },
      ] satisfies AgentRuntimeEvent[]
    default:
      return assertNever(row)
  }
}

function assistantText(message: Extract<SDKMessage, { type: "assistant" }>) {
  return message.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("")
}

function toolBlocks(message: Extract<SDKMessage, { type: "assistant" }>) {
  return message.message.content.flatMap((block) => block.type === "tool_use" ? [block] : [])
}

export function cursorSdkAdapter(): HarnessEventAdapter<CursorSdkAdapterState> {
  return {
    name: "cursor-sdk",
    createInitialState: createCursorSdkAdapterState,
    translate({ state, event, context }) {
      const row = payload(event)
      const stream = isLocalRunStreamEvent(row) ? row : undefined
      if (stream) {
        switch (stream.type) {
          case "sdk_message":
            return translateSdkMessage({ state, event, context, message: stream.message })
          case "result":
          case "done":
            return { state: pruneTurnState(), events: localRunTerminalEvents(stream, context) }
          default:
            return assertNever(stream)
        }
      }

      if (!isSdkMessage(row)) {
        return unmappedSdkEvent({
          sdkEvent: `SDKMessage(${text(row.type) ?? "unknown"})`,
          reason: "payload is not a known Cursor SDK message type",
          event,
          severity: "warn",
        })
      }

      return translateSdkMessage({ state, event, context, message: row })
    },
  }
}

function translateSdkMessage(input: {
  state: CursorSdkAdapterState
  event: { source: string; method?: string; payload: unknown }
  context: HarnessEventAdapterContext
  message: SDKMessage
}): HarnessEventAdapterResult<CursorSdkAdapterState> | AgentRuntimeEvent[] {
  const state = input.state
  const event = input.event
  const context = input.context
  const message = input.message

  switch (message.type) {
        case "assistant": {
          const snapshot = assistantText(message)
          const previous = state.assistantTextByRunId[message.run_id] ?? ""
          const delta = snapshot.startsWith(previous)
            ? snapshot.slice(previous.length)
            : previous.endsWith(snapshot)
              ? ""
              : snapshot
          const toolResults = toolBlocks(message).reduce<{ state: CursorSdkAdapterState; events: AgentRuntimeEvent[] }>(
            (current, block) => {
              if (isTodoTool(block.name)) {
                const todos = todosFromInput(toolInput(block.input))
                return {
                  state: current.state,
                  events: [
                    ...current.events,
                    ...(todos.length ? [{ type: "todo-update", todos } satisfies AgentRuntimeEvent] : []),
                  ],
                }
              }
              const ensured = ensureTool({
                state: current.state,
                toolCallId: block.id,
                toolName: block.name,
                rawInput: toolInput(block.input),
              })
              return { state: ensured.state, events: [...current.events, ...ensured.events] }
            },
            { state, events: [] satisfies AgentRuntimeEvent[] },
          )
          return {
            state: {
              ...toolResults.state,
              assistantTextByRunId: { ...toolResults.state.assistantTextByRunId, [message.run_id]: snapshot || previous },
            },
            events: [
              ...(delta ? [{ type: "text-delta", delta } satisfies AgentRuntimeEvent] : []),
              ...toolResults.events,
            ],
          }
        }

        case "thinking": {
          const previous = state.thinkingTextByRunId[message.run_id] ?? ""
          const delta = message.text.startsWith(previous)
            ? message.text.slice(previous.length)
            : previous.endsWith(message.text)
              ? ""
              : message.text
          return {
            state: {
              ...state,
              thinkingTextByRunId: { ...state.thinkingTextByRunId, [message.run_id]: message.text || previous },
            },
            events: delta ? [{ type: "thinking-delta", delta } satisfies AgentRuntimeEvent] : [],
          }
        }

        case "tool_call": {
          const rawInput = toolInput(message.args)
          if (isTodoTool(message.name)) {
            const todos = todosFromInput(rawInput)
            return todos.length ? [{ type: "todo-update", todos }] : []
          }
          const status = message.status
          switch (status) {
            case "running": {
              const ensured = ensureTool({
                state,
                toolCallId: message.call_id,
                toolName: message.name,
                rawInput,
              })
              return {
                state: ensured.state,
                events: [
                  ...ensured.events,
                  { type: "tool-status", toolCallId: message.call_id, status: "running", display: ensured.display, metadata: { cursor: { itemType: ensured.kind, truncated: message.truncated } } },
                ],
              }
            }
            case "completed":
            case "error":
              return toolCompletedEvents({
                state,
                toolCallId: message.call_id,
                toolName: message.name,
                rawInput,
                result: message.result,
                isError: status === "error",
              })
            default:
              return assertNever(status)
          }
        }

        case "status": {
          const events = statusEvents(message, context)
          return isTerminalSdkStatus(message.status) ? { state: pruneTurnState(), events } : events
        }

        case "system":
          return [
            { type: "session-agent", agentId: message.agent_id },
            ...unmappedSdkEvent({
              sdkEvent: `SDKSystemMessage(${message.subtype ?? "unknown"})`,
              reason: "model and tool inventory have no complete AgentRuntimeEvent mapping",
              event,
            }),
          ]

        case "task": {
          const taskText = text(message.text)
          return taskText
            ? [diagnosticForEvent({
              code: "cursor_sdk.task_progress",
              message: taskText,
              severity: "info",
              event,
              details: { status: message.status },
            })]
            : []
        }

        case "request":
          return []

        case "user":
          return []

        default:
          return assertNever(message)
      }
}
