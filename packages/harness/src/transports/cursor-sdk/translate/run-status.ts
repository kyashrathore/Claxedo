import { asRecord } from "@claxedo/helpers/guards"
import type { LocalRunStreamEvent, LocalRunStreamResultEvent, SDKMessage } from "@cursor/sdk"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asText as text } from "@claxedo/agent-runtime-contract"
import { unknownKind } from "./frames"
import { cursorErrorClass } from "./run-errors"
import { endedRunState, unchanged, type CursorSdkAdapterState, type CursorTranslation } from "./state"

export type CursorRunResult = LocalRunStreamResultEvent & { error?: { message: string; code?: string } }

export function statusEvents(state: CursorSdkAdapterState, message: Extract<SDKMessage, { type: "status" }>): CursorTranslation {
  const status = message.status
  switch (status) {
    case "CREATING":
    case "RUNNING":
      return unchanged(state, [{ type: "session-status", status: "busy" }])
    case "FINISHED":
    case "CANCELLED":
    case "ERROR":
    case "EXPIRED":
      return unchanged(state)
    default:
      return unknownKind(state, `status:${String(status)}`)
  }
}

function failedRun(row: CursorRunResult): AgentRuntimeEvent[] {
  const error = asRecord(row.error)
  const code = text(error?.code)
  const errorClass = cursorErrorClass(code)
  return [
    { type: "session-status", status: "error" },
    { type: "error", error: text(error?.message) ?? row.errorCode ?? "Cursor run failed", ...(errorClass ? { errorClass } : {}) },
  ]
}

function runEndEvents(state: CursorSdkAdapterState, row: CursorRunResult): CursorTranslation {
  const status = row.status
  switch (status) {
    case "finished":
      return { state: endedRunState(state), events: [{ type: "session-status", status: "idle" }, { type: "finish", sessionId: row.runId }] }
    case "cancelled":
      return { state: endedRunState(state), events: [{ type: "session-status", status: "idle" }, { type: "cancelled", sessionId: row.runId }] }
    case "error":
      return { state: endedRunState(state), events: failedRun(row) }
    default:
      return unknownKind(state, `result:${String(status)}`)
  }
}

export function localRunTerminalEvents(state: CursorSdkAdapterState, row: Exclude<LocalRunStreamEvent, { type: "sdk_message" }>): CursorTranslation {
  switch (row.type) {
    case "result":
      return runEndEvents(state, row)
    case "done":
      return { state: endedRunState(state), events: [{ type: "session-status", status: "idle" }, { type: "finish", sessionId: row.runId }] }
  }
}
