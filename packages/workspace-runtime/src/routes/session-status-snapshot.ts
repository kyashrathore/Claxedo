import type { AgentRuntimeStatus } from "@claxedo/agent-runtime-contract"
import { ACP_RECOVER } from "../store"
import { recovering } from "../projection/presentation-events"
import { str } from "../json-value"
import { asRecord } from "@claxedo/helpers/guards"

export type SessionStatusSnapshot = Record<string, AgentRuntimeStatus>

export function sessionStatusSnapshot(input: unknown[]): SessionStatusSnapshot {
  const out: SessionStatusSnapshot = {}
  for (const item of input) {
    const row = asRecord(item)
    if (!row) continue
    const id = str(row.id)
    if (!id) continue
    const status = live(row, ACP_RECOVER)
    if (!status) continue
    out[id] = status
  }
  return out
}

function live(input: Record<string, unknown>, defaultMessage: string, now = Date.now()): AgentRuntimeStatus | undefined {
  if (input.status === "busy") return { type: "busy" }
  if (input.status === "recovering") {
    return recovering(typeof input.message === "string" ? input.message : typeof input.recovery_error === "string" ? input.recovery_error : defaultMessage)
  }
  if (input.status !== "retry") return undefined
  return {
    type: "retry",
    attempt: typeof input.attempt === "number" ? input.attempt : 1,
    message: typeof input.message === "string" ? input.message : defaultMessage,
    next: typeof input.next === "number" ? input.next : now,
  }
}
