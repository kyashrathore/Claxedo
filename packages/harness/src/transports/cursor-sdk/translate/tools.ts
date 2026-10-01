import { asRecord } from "@claxedo/helpers/guards"
import type { AgentRuntimeEvent, ToolDisplay } from "@claxedo/agent-runtime-contract"
import { asText as text } from "@claxedo/agent-runtime-contract"
import { toolDisplayFromInput } from "../../../translate/tool-display"
import { isHostSubagentTool } from "../../../translate/host-subagent"
import { RETAINED_WIRE_KEYS_MAX, boundKeyedRecord, own } from "../../../translate/value"
import type { CursorSdkAdapterState, CursorToolRecord } from "./state"

const TODO_TOOLS = ["updatetodos", "readtodos"]

export function toolInput(value: unknown) {
  const input = asRecord(value) ?? {}
  return text(input.workingDirectory) && !input.cwd
    ? { ...input, cwd: input.workingDirectory }
    : input
}

export function cursorToolName(name: string, args: Record<string, unknown>) {
  if (name !== "mcp") return name
  const server = text(args.providerIdentifier)
  const tool = text(args.toolName)
  return server && tool ? `mcp__${server}__${tool}` : name
}

export function isTodoTool(toolName: string) {
  return TODO_TOOLS.includes(toolName.toLowerCase())
}

export function isTaskTool(toolName: string) {
  return toolName.toLowerCase() === "task"
}

function cursorTodoStatus(value: unknown) {
  if (value === "completed" || value === "cancelled") return value
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
  if (normalized === "mcp" || normalized.startsWith("mcp__")) return "mcp_tool_call"
  if (normalized === "shell") return "command_execution"
  if (normalized === "delete") return "delete"
  if (normalized === "edit") return "file_change"
  if (normalized === "read" || normalized === "readlints") return "file_read"
  if (normalized === "grep" || normalized === "glob" || normalized === "semsearch") return "web_search"
  if (normalized === "createplan") return "plan"
  if (normalized === "generateimage") return "image_view"
  return "dynamic_tool_call"
}

type EnsuredTool = { state: CursorSdkAdapterState; events: AgentRuntimeEvent[]; toolName: string; kind: string; display: ToolDisplay }

function recorded(state: CursorSdkAdapterState, toolCallId: string, record: CursorToolRecord): CursorSdkAdapterState {
  return { ...state, toolsByCallId: boundKeyedRecord({ ...state.toolsByCallId, [toolCallId]: record }, RETAINED_WIRE_KEYS_MAX) }
}

function inputEvent(toolCallId: string, record: CursorToolRecord, display: ToolDisplay): AgentRuntimeEvent {
  return { type: "tool-input", toolCallId, input: record.input ?? {}, display, metadata: { cursor: { itemType: record.kind } } }
}

function changedInput(previous: Record<string, unknown> | undefined, next: Record<string, unknown> | undefined) {
  return next !== undefined && Object.entries(next).some(([key, value]) => JSON.stringify(previous?.[key]) !== JSON.stringify(value))
}

export function ensureTool(input: { state: CursorSdkAdapterState; toolCallId: string; toolName: string; rawInput?: Record<string, unknown> }): EnsuredTool {
  const existing = own(input.state.toolsByCallId, input.toolCallId)
  const toolName = existing?.toolName ?? input.toolName
  const merged = existing?.input || input.rawInput ? { ...existing?.input, ...input.rawInput } : undefined
  const record: CursorToolRecord = { toolName, kind: existing?.kind ?? toolKind(toolName), ...(merged ? { input: merged } : {}) }
  const display = toolDisplayFromInput({ kind: record.kind, toolName, ...(merged && Object.keys(merged).length ? { input: merged } : {}) })
  const state = recorded(input.state, input.toolCallId, record)
  const events: AgentRuntimeEvent[] = existing
    ? changedInput(existing.input, input.rawInput) ? [inputEvent(input.toolCallId, record, display)] : []
    : [{ type: "tool-start", toolCallId: input.toolCallId, toolName, kind: record.kind, display, metadata: { cursor: { itemType: record.kind } } },
      ...(merged && Object.keys(merged).length ? [inputEvent(input.toolCallId, record, display)] : [])]
  return { state, events, toolName, kind: record.kind, display }
}

export function successfulOutput(value: unknown) {
  const row = asRecord(value)
  if (row?.status === "success" && row.value !== undefined) return row.value
  return value
}

export function mcpContentTexts(value: unknown): string[] {
  const content = asRecord(successfulOutput(value))?.content
  return Array.isArray(content) ? content.flatMap((item) => text(asRecord(asRecord(item)?.text)?.text) ?? []) : []
}
