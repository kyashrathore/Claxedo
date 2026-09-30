import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asText as text } from "@claxedo/agent-runtime-contract"
import { itemId, type CodexFrame, type CodexHandler, type CodexHandlers } from "./frame"
import { structuredInput } from "./item-input"
import { appendToolText, base64Text, ensureTool, processExitEvents } from "./tool-state"

function itemDelta(itemType: string, prefix: string, field: "delta" | "message"): CodexHandler {
  return ({ state, event, context, method, row }) => {
    const id = itemId(event, context.createId(prefix))
    return appendToolText({
      state,
      toolCallId: id,
      itemType,
      delta: text(row[field]),
      metadata: { codex: { method, threadId: row.threadId, turnId: row.turnId, itemId: id } },
    })
  }
}

function processDelta(key: "processId" | "processHandle", toolName: string): CodexHandler {
  return ({ state, context, method, row }) => {
    const id = text(row[key]) ?? context.createId("process")
    return appendToolText({
      state,
      toolCallId: id,
      itemType: "command_execution",
      toolName,
      rawInput: structuredInput({ [key]: id, stream: row.stream }),
      delta: base64Text(row.deltaBase64),
      metadata: { codex: { method, [key]: id, stream: row.stream, capReached: row.capReached } },
    })
  }
}

function terminalInteraction({ state, event, context, row }: CodexFrame) {
  const id = itemId(event, context.createId("command"))
  const ensured = ensureTool({ state, toolCallId: id, itemType: "command_execution", rawInput: structuredInput(row) })
  const terminalId = text(row.processId)
  return {
    state: ensured.state,
    events: terminalId ? [...ensured.events, { type: "tool-terminal", toolCallId: id, terminalId } satisfies AgentRuntimeEvent] : ensured.events,
  }
}

function patchUpdated({ state, event, context, row }: CodexFrame) {
  const id = itemId(event, context.createId("file-change"))
  const ensured = ensureTool({ state, toolCallId: id, itemType: "file_change" })
  const diffs = Array.isArray(row.changes)
    ? row.changes.flatMap((change) => {
      const item = asRecord(change)
      const path = text(item?.path)
      const diff = text(item?.diff)
      if (!path || !diff) return []
      return [{ type: "file-diff", toolCallId: id, path, newText: diff } satisfies AgentRuntimeEvent]
    })
    : []
  return { state: ensured.state, events: [...ensured.events, ...diffs] }
}

function processExited({ state, context, method, row }: CodexFrame) {
  const id = text(row.processHandle) ?? context.createId("process")
  const exitCode = asFiniteNumber(row.exitCode)
  return processExitEvents({
    state,
    toolCallId: id,
    row,
    metadata: {
      ...(exitCode === undefined ? {} : { exitCode }),
      codex: { method, processHandle: id, stdoutCapReached: row.stdoutCapReached, stderrCapReached: row.stderrCapReached },
    },
  })
}

export const toolStreamHandlers: CodexHandlers = {
  "command/exec/outputDelta": processDelta("processId", "command"),
  "process/outputDelta": processDelta("processHandle", "process"),
  "item/commandExecution/outputDelta": itemDelta("command_execution", "command", "delta"),
  "item/fileChange/outputDelta": itemDelta("file_change", "file-change", "delta"),
  "item/mcpToolCall/progress": itemDelta("mcp_tool_call", "mcp", "message"),
  "item/commandExecution/terminalInteraction": terminalInteraction,
  "item/fileChange/patchUpdated": patchUpdated,
  "process/exited": processExited,
}
