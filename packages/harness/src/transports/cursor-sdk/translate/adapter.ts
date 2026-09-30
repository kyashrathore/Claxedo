import { asText as text } from "@claxedo/agent-runtime-contract"
import type { HarnessEventAdapter } from "../../../translate/adapter"
import { assertNever, isLocalRunStreamEvent, isSdkMessage, payload, unmappedSdkEvent } from "./frames"
import { localRunTerminalEvents } from "./run-status"
import { translateSdkMessage } from "./sdk-message"
import { createCursorSdkAdapterState, pruneTurnState, type CursorSdkAdapterState } from "./state"

export type { CursorSdkAdapterState } from "./state"
export type { CursorSubagentObservation } from "./tasks"
export { cursorRuntimeMessage, cursorSubagentObservations } from "./tasks"

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
            return { state: pruneTurnState(), events: localRunTerminalEvents(stream) }
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
