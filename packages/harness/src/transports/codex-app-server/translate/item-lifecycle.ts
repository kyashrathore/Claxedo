import { asFiniteNumber } from "@claxedo/helpers/guards"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asText as text } from "@claxedo/agent-runtime-contract"
import { RETAINED_WIRE_KEYS_MAX, boundKeyedRecord, own } from "../../../translate/value"
import { item, itemId, type CodexFrame, type CodexHandlers } from "./frame"
import { itemInput, itemMetadata } from "./item-input"
import { canonicalItemType, toolDisplay, toolNameForItem } from "./item-kind"
import { itemOutcome } from "./item-outcome"
import { completedAssistantMessage, completedReasoning } from "./message-items"
import { withoutStreamedItem, type CodexAppServerAdapterState } from "./state"
import { codexSubagentActivity } from "./subagent-items"

type Row = Record<string, unknown>

function rememberTool(state: CodexAppServerAdapterState, id: string, tool: { toolName: string; input?: Row; itemType: string }) {
  return { ...state, toolsByItemId: boundKeyedRecord({ ...state.toolsByItemId, [id]: tool }, RETAINED_WIRE_KEYS_MAX) }
}

function openTool(state: CodexAppServerAdapterState, id: string, itemType: string, row: Row) {
  const toolName = toolNameForItem(itemType, row)
  const input = itemInput(row)
  const display = toolDisplay(itemType, input, toolName)
  const metadata = itemMetadata(itemType, row)
  return {
    state: rememberTool(withoutStreamedItem(state), id, { toolName, input, itemType }),
    display,
    events: [
      { type: "tool-start", toolCallId: id, toolName, kind: itemType, display, metadata },
      ...(input ? [{ type: "tool-input", toolCallId: id, input, display, metadata } satisfies AgentRuntimeEvent] : []),
    ] satisfies AgentRuntimeEvent[],
  }
}

function settledInput(state: CodexAppServerAdapterState, id: string, itemType: string, completed: Row) {
  const existing = own(state.toolsByItemId, id)!
  const input = itemInput(completed)
  const display = toolDisplay(itemType, input ?? existing.input, existing.toolName)
  if (!input || JSON.stringify(input) === JSON.stringify(existing.input)) return { state, display, events: [] satisfies AgentRuntimeEvent[] }
  return {
    state: rememberTool(state, id, { ...existing, input, itemType }),
    display,
    events: [{ type: "tool-input", toolCallId: id, input, display, metadata: itemMetadata(itemType, completed) } satisfies AgentRuntimeEvent],
  }
}

function completedToolItem(state: CodexAppServerAdapterState, id: string, itemType: string, completed: Row) {
  const outcome = itemOutcome(state, id, itemType, completed)
  const exitCode = asFiniteNumber(completed.exitCode)
  const metadata = { ...(exitCode === undefined ? {} : { exitCode }), ...itemMetadata(itemType, completed) }
  const opened = own(state.toolsByItemId, id) ? settledInput(state, id, itemType, completed) : openTool(state, id, itemType, completed)
  const completion = "error" in outcome
    ? { type: "tool-error" as const, toolCallId: id, error: outcome.error }
    : { type: "tool-output" as const, toolCallId: id, output: outcome.output, ...(outcome.attachments.length ? { attachments: outcome.attachments } : {}) }
  const events = [...opened.events, { ...completion, display: opened.display, metadata }]
  return opened.state === state ? events : { state: opened.state, events }
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
