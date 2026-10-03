import { asRecord } from "@claxedo/helpers/guards"
import { asText as text } from "@claxedo/agent-runtime-contract"
import type { HarnessEventAdapter } from "../../../translate/adapter"
import { isCursorRunResult, localRunTerminalEvents } from "./run-status"
import { translateSdkMessage } from "./sdk-message"
import { isShellOutputDelta, shellOutputEvents } from "./shell-output"
import { createCursorSdkAdapterState, type CursorSdkAdapterState, type CursorTranslation } from "./state"

export type { CursorSdkAdapterState } from "./state"
export type { CursorRunResult } from "./run-status"
export type { CursorSubagentObservation } from "./tasks"
export { cursorRuntimeMessage, cursorSubagentObservations } from "./tasks"
export { nestedTaskMessage } from "./nested"

function translateRow(state: CursorSdkAdapterState, row: Record<string, unknown>): CursorTranslation {
  if (isCursorRunResult(row)) return localRunTerminalEvents(state, row)
  if (isShellOutputDelta(row)) return shellOutputEvents(state, row)
  return translateSdkMessage(state, row, text(row.type) ?? typeof row.type)
}

export function cursorSdkAdapter(): HarnessEventAdapter<CursorSdkAdapterState> {
  return {
    name: "cursor-sdk",
    createInitialState: createCursorSdkAdapterState,
    translate: ({ state, event }) => translateRow(state, asRecord(event.payload) ?? {}),
  }
}
