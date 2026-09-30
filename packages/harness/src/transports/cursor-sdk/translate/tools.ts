import { asRecord } from "@claxedo/helpers/guards"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asText as text } from "@claxedo/agent-runtime-contract"
import { toolDisplayFromInput } from "../../../translate/tool-display"
import { isHostSubagentTool } from "../../../translate/host-subagent"
import { RETAINED_WIRE_KEYS_MAX, boundKeyedRecord, own } from "../../../translate/value"
import type { CursorSdkAdapterState } from "./state"

export function toolInput(value: unknown) {
  const input = asRecord(value) ?? {}
  return text(input.workingDirectory) && !input.cwd
    ? { ...input, cwd: input.workingDirectory }
    : input
}

export function isTodoTool(toolName: string) {
  return toolName.toLowerCase().includes("todo")
}

export function isTaskTool(toolName: string) {
  return toolName.toLowerCase() === "task"
}

function cursorTodoStatus(value: unknown) {
  if (value === "completed") return "completed"
  if (value === "inProgress" || value === "in_progress") return "in_progress"
  return "pending"
}

export function todosFromInput(input: Record<string, unknown>) {
  const todos = Array.isArray(input.todos) ? input.todos : []
  return todos.flatMap((todo, i) => {
    const row = asRecord(todo)
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
  if (isTaskTool(toolName) || isHostSubagentTool(toolName)) return "collab_agent_tool_call"
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

export function ensureTool(input: {
  state: CursorSdkAdapterState
  toolCallId: string
  toolName: string
  rawInput?: Record<string, unknown>
}) {
  const existing = own(input.state.toolsByCallId, input.toolCallId)
  const toolName = existing?.toolName ?? input.toolName
  const rawInput = existing?.input || input.rawInput
    ? { ...existing?.input, ...input.rawInput }
    : undefined
  const kind = existing?.kind ?? toolKind(toolName)
  const display = toolDisplay(toolName, rawInput ?? {})
  if (existing) {
    const inputChanged = input.rawInput && Object.entries(input.rawInput)
      .some(([key, value]) => JSON.stringify(existing.input?.[key]) !== JSON.stringify(value))
    return {
      state: {
        ...input.state,
        toolsByCallId: boundKeyedRecord({
          ...input.state.toolsByCallId,
          ...input.state.toolsByCallId,
          [input.toolCallId]: {
            toolName,
            kind,
            ...(rawInput ? { input: rawInput } : {}),
          },
        }, RETAINED_WIRE_KEYS_MAX),
      },
      events: inputChanged
        ? [{ type: "tool-input", toolCallId: input.toolCallId, input: rawInput ?? {}, display, metadata: { cursor: { itemType: kind } } } satisfies AgentRuntimeEvent]
        : [],
      toolName,
      rawInput,
      kind,
      display,
    }
  }
  return {
    state: {
      ...input.state,
      toolsByCallId: boundKeyedRecord({
        ...input.state.toolsByCallId,
        ...input.state.toolsByCallId,
        [input.toolCallId]: {
          toolName,
          kind,
          ...(rawInput ? { input: rawInput } : {}),
        },
      }, RETAINED_WIRE_KEYS_MAX),
    },
    events: [
      { type: "tool-start", toolCallId: input.toolCallId, toolName, kind, display, metadata: { cursor: { itemType: kind } } },
      ...(rawInput && Object.keys(rawInput).length
        ? [{ type: "tool-input", toolCallId: input.toolCallId, input: rawInput, display, metadata: { cursor: { itemType: kind } } } satisfies AgentRuntimeEvent]
        : []),
    ] satisfies AgentRuntimeEvent[],
    toolName,
    rawInput,
    kind,
    display,
  }
}

export function successfulOutput(value: unknown) {
  const row = asRecord(value)
  if (row?.status === "success" && row.value !== undefined) return row.value
  return value
}
