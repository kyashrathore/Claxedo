import type { ShellOutputDeltaUpdate } from "@cursor/sdk"
import { asRecord, isRecord } from "@claxedo/helpers/guards"
import { asText as text } from "@claxedo/agent-runtime-contract"
import { own } from "../../../translate/value"
import { unknownKind } from "./frames"
import { unchanged, type CursorSdkAdapterState, type CursorTranslation } from "./state"

export function openedShell(state: CursorSdkAdapterState, toolCallId: string): CursorSdkAdapterState {
  return state.openShells.includes(toolCallId) ? state : { ...state, openShells: [...state.openShells, toolCallId] }
}

export function closedShell(state: CursorSdkAdapterState, toolCallId: string): CursorSdkAdapterState {
  if (!state.openShells.includes(toolCallId)) return state
  const { [toolCallId]: _output, ...shellOutputByCallId } = state.shellOutputByCallId
  return { ...state, openShells: state.openShells.filter((id) => id !== toolCallId), shellOutputByCallId }
}

export function isShellOutputDelta(row: Record<string, unknown>): row is Record<string, unknown> & ShellOutputDeltaUpdate {
  return row.type === "shell-output-delta" && isRecord(row.event)
}

export function shellOutputEvents(state: CursorSdkAdapterState, update: ShellOutputDeltaUpdate): CursorTranslation {
  const stream = update.event.case
  if (stream !== "stdout" && stream !== "stderr") return unchanged(state)
  const data = text(asRecord(update.event.value)?.data)
  if (!data) return unchanged(state)
  if (state.openShells.length !== 1) return unknownKind(state, `shell-output:${state.openShells.length ? "several running shells" : "no running shell"}`)
  const toolCallId = state.openShells[0]!
  const output = `${own(state.shellOutputByCallId, toolCallId) ?? ""}${data}`
  return {
    state: { ...state, shellOutputByCallId: { ...state.shellOutputByCallId, [toolCallId]: output } },
    events: [{ type: "tool-content", toolCallId, content: { type: "content", content: { type: "text", text: output } },
      metadata: { cursor: { itemType: "command_execution", stream } } }],
  }
}
