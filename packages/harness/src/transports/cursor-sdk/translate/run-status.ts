import { asRecord } from "@claxedo/helpers/guards"
import type { LocalRunStreamResultEvent, SDKMessage } from "@cursor/sdk"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asText as text } from "@claxedo/agent-runtime-contract"
import { unknownKind } from "./frames"
import { cursorErrorClass } from "./run-errors"
import { endedRunState, unchanged, type CursorSdkAdapterState, type CursorTranslation } from "./state"
import { own } from "../../../translate/value"

export type CursorRunResult = LocalRunStreamResultEvent & { error?: { message: string; code?: string } }

const statusProtocolMap: Partial<Record<Extract<SDKMessage, { type: "status" }>["status"], "busy" | null>> = {
  CREATING: "busy",
  RUNNING: "busy",
  FINISHED: null,
  CANCELLED: null,
  ERROR: null,
  EXPIRED: null,
}

export function statusEvents(state: CursorSdkAdapterState, message: Extract<SDKMessage, { type: "status" }>): CursorTranslation {
  const status = own(statusProtocolMap, message.status)
  if (status === undefined) return unknownKind(state, `status:${message.status}`)
  return unchanged(state, status ? [{ type: "session-status", status }] : [])
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

export function isCursorRunResult(row: Record<string, unknown>): row is Record<string, unknown> & CursorRunResult {
  return row.type === "result" && typeof row.runId === "string" && typeof row.status === "string"
}

export function localRunTerminalEvents(state: CursorSdkAdapterState, row: CursorRunResult): CursorTranslation {
  if (row.status === "finished" || row.status === "cancelled") {
    const type = row.status === "cancelled" ? "cancelled" : "finish"
    return { state: endedRunState(state), events: [{ type: "session-status", status: "idle" }, { type, sessionId: row.runId }] }
  }
  return row.status === "error" ? { state: endedRunState(state), events: failedRun(row) } : unknownKind(state, `result:${String(row.status)}`)
}
