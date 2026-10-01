import { asRecord } from "@claxedo/helpers/guards"
import { asText as text } from "@claxedo/agent-runtime-contract"
import type { LocalRunStreamEvent, ShellOutputDeltaUpdate } from "@cursor/sdk"
import type { HarnessEventAdapter } from "../../../translate/adapter"
import { localRunTerminalEvents } from "./run-status"
import { translateSdkMessage } from "./sdk-message"
import { shellOutputEvents } from "./shell-output"
import { createCursorSdkAdapterState, type CursorSdkAdapterState, type CursorTranslation } from "./state"

export type { CursorSdkAdapterState } from "./state"
export type { CursorRunResult } from "./run-status"
export type { CursorSubagentObservation } from "./tasks"
export { cursorRuntimeMessage, cursorSubagentObservations } from "./tasks"
export { nestedTaskMessage } from "./nested"

function translateRow(state: CursorSdkAdapterState, row: Record<string, unknown>): CursorTranslation {
  if (row.type === "sdk_message") return translateSdkMessage(state, row.message as Record<string, unknown>)
  if (row.type === "result" || row.type === "done") return localRunTerminalEvents(state, row as unknown as Exclude<LocalRunStreamEvent, { type: "sdk_message" }>)
  if (row.type === "shell-output-delta" && asRecord(row.event)) return shellOutputEvents(state, row as unknown as ShellOutputDeltaUpdate)
  return translateSdkMessage(state, row, text(row.type) ?? typeof row.type)
}

export function cursorSdkAdapter(): HarnessEventAdapter<CursorSdkAdapterState> {
  return {
    name: "cursor-sdk",
    createInitialState: createCursorSdkAdapterState,
    translate: ({ state, event }) => translateRow(state, asRecord(event.payload) ?? {}),
  }
}
