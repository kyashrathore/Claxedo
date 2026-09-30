import { asText as text } from "@claxedo/agent-runtime-contract"
import type { HarnessEventAdapter } from "../../../translate/adapter"
import { isLocalRunStreamEvent, isSdkMessage, payload, unknownKind } from "./frames"
import { localRunTerminalEvents } from "./run-status"
import { translateSdkMessage } from "./sdk-message"
import { createCursorSdkAdapterState, type CursorSdkAdapterState, type CursorTranslation } from "./state"

export type { CursorSdkAdapterState } from "./state"
export type { CursorRunResult } from "./run-status"
export type { CursorSubagentObservation } from "./tasks"
export { cursorRuntimeMessage, cursorSubagentObservations } from "./tasks"

function translateRow(state: CursorSdkAdapterState, row: Record<string, unknown>): CursorTranslation {
  if (isLocalRunStreamEvent(row)) return row.type === "sdk_message" ? translateSdkMessage(state, row.message) : localRunTerminalEvents(state, row)
  if (isSdkMessage(row)) return translateSdkMessage(state, row)
  return unknownKind(state, `message:${text(row.type) ?? typeof row.type}`)
}

export function cursorSdkAdapter(): HarnessEventAdapter<CursorSdkAdapterState> {
  return {
    name: "cursor-sdk",
    createInitialState: createCursorSdkAdapterState,
    translate: ({ state, event }) => translateRow(state, payload(event)),
  }
}
