import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asText as text } from "@claxedo/agent-runtime-contract"
import { contentBlockImages, imageUrlAttachment } from "../../../translate/tool-attachments"
import { RETAINED_WIRE_KEYS_MAX, boundKeyedRecord, own } from "../../../translate/value"
import { item, itemId, type CodexFrame, type CodexHandlers } from "./frame"
import { canonicalItemType, structuredInput, toolDisplay, toolNameForItem } from "./item-kind"
import { completedAssistantMessage, completedReasoning } from "./message-items"
import type { CodexAppServerAdapterState } from "./state"
import { codexSubagentActivity } from "./subagent-items"

function mcpError(itemType: string, completed: Record<string, unknown>) {
  if (itemType !== "mcp_tool_call") return undefined
  const explicit = text(asRecord(completed.error)?.message)
  if (explicit || completed.status !== "failed") return explicit
  const result = asRecord(completed.result)
  return (Array.isArray(result?.content) ? result.content.flatMap((part) => text(asRecord(part)?.text) ?? []).join("\n") : "") || "MCP tool call failed"
}

function completedItemAttachments(itemType: string, completed: Record<string, unknown>) {
  return [
    ...(itemType === "image_view" && text(completed.path)
      ? [{ kind: "tool-file" as const, mime: "image/*", path: String(completed.path), filename: String(completed.path).split(/[\\/]/).pop() }]
      : []),
    ...contentBlockImages(asRecord(completed.result)?.content),
    ...(Array.isArray(completed.contentItems) ? completed.contentItems : []).flatMap((item) =>
      asRecord(item)?.type === "inputImage" ? imageUrlAttachment(asRecord(item)?.imageUrl) : []),
  ]
}

function toolCompletion(state: CodexAppServerAdapterState, id: string, itemType: string, completed: Record<string, unknown>) {
  const output = completed.output ?? completed.result ?? completed.aggregatedOutput ?? completed.text ?? own(state.toolOutputByCallId, id) ?? ""
  const exitCode = asFiniteNumber(completed.exitCode)
  const failure = mcpError(itemType, completed)
  const commandStatus = itemType === "command_execution" ? text(completed.status) : undefined
  const attachments = completedItemAttachments(itemType, completed)
  if (failure !== undefined) return { type: "tool-error" as const, toolCallId: id, error: failure }
  if (commandStatus === "declined") return { type: "tool-error" as const, toolCallId: id, error: "User declined the command" }
  if (commandStatus === "failed") return { type: "tool-error" as const, toolCallId: id, error: text(output) ?? `Process exited with code ${exitCode}` }
  return { type: "tool-output" as const, toolCallId: id, output, ...(attachments.length ? { attachments } : {}) }
}

function openTool(state: CodexAppServerAdapterState, id: string, itemType: string, row: Record<string, unknown>) {
  const toolName = toolNameForItem(itemType, row)
  const input = structuredInput(row)
  const display = toolDisplay(itemType, input, toolName)
  const metadata = { codex: { itemType } }
  return {
    state: { ...state, toolsByItemId: boundKeyedRecord({ ...state.toolsByItemId, [id]: { toolName, input, itemType } }, RETAINED_WIRE_KEYS_MAX) },
    display,
    events: [
      { type: "tool-start", toolCallId: id, toolName, kind: itemType, display, metadata },
      ...(input ? [{ type: "tool-input", toolCallId: id, input, display, metadata } satisfies AgentRuntimeEvent] : []),
    ] satisfies AgentRuntimeEvent[],
  }
}

function completedToolItem(state: CodexAppServerAdapterState, id: string, itemType: string, completed: Record<string, unknown>) {
  const completion = toolCompletion(state, id, itemType, completed)
  const exitCode = asFiniteNumber(completed.exitCode)
  const metadata = { ...(exitCode === undefined ? {} : { exitCode }), codex: { itemType } }
  const existing = own(state.toolsByItemId, id)
  if (existing) return [{ ...completion, display: toolDisplay(itemType, existing.input, existing.toolName), metadata }]
  const opened = openTool(state, id, itemType, completed)
  return { state: opened.state, events: [...opened.events, { ...completion, display: opened.display, metadata }] }
}

function itemCompleted({ state, event, context, row }: CodexFrame) {
  const completed = item(event)
  if (!completed) return []
  if (codexSubagentActivity(completed)?.kind === "completed") return []
  if (completed.type === "contextCompaction") return [{ type: "session-compaction", phase: "completed", metadata: { codex: row } } satisfies AgentRuntimeEvent]
  const id = itemId(event, context.createId("item"))
  const itemType = canonicalItemType(completed.type)
  if (itemType === "user_message") return []
  if (itemType === "plan") {
    const planMarkdown = text(completed.text) ?? text(completed.summary)
    return planMarkdown ? [{ type: "proposed-plan-complete", planMarkdown } satisfies AgentRuntimeEvent] : []
  }
  if (itemType === "assistant_message") return completedAssistantMessage(state, id, completed)
  if (itemType === "reasoning") return completedReasoning(state, id, completed)
  if (itemType === "error") return [{ type: "error", error: text(completed.message) ?? text(completed.text) ?? "Codex item failed" } satisfies AgentRuntimeEvent]
  return completedToolItem(state, id, itemType, completed)
}

function itemStarted({ state, event, context, row }: CodexFrame) {
  const started = item(event) ?? row
  if (codexSubagentActivity(started)?.kind === "completed") return []
  if (started.type === "contextCompaction") return [{ type: "session-compaction", phase: "started", metadata: { codex: row } } satisfies AgentRuntimeEvent]
  const id = itemId(event, context.createId("item"))
  const itemType = canonicalItemType(started.type)
  if (itemType === "user_message" || itemType === "assistant_message" || itemType === "reasoning" || itemType === "plan") return []
  const opened = openTool(state, id, itemType, started)
  return { state: opened.state, events: opened.events }
}

export const itemHandlers: CodexHandlers = {
  "item/completed": itemCompleted,
  "item/started": itemStarted,
}
