import { asRecord } from "@claxedo/helpers/guards"

export type ExecutionAvailability =
  | { status: "available" }
  | { status: "selection-required"; selection: "harness" | "model" }
  | { status: "offline"; message: string }
  | { status: "unsupported"; operation: string }
  | { status: "unavailable"; message: string; connectionId?: string }
  | { status: "upstream-error"; message: string; connectionId?: string }

export type AgentRuntimeStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; message: string; attempt?: number; next?: number; action?: { reason: string; provider: string; title: string; message: string; label: string; link?: string } }
  | { type: "interrupted"; message: string }

function assertExecutionAvailability(value: unknown): asserts value is ExecutionAvailability {
  const row = asRecord(value)
  if (!row) throw new TypeError("Invalid execution availability")
  const optionalConnection = row.connectionId === undefined || typeof row.connectionId === "string"
  if (row.status === "available" || row.status === "selection-required" && (row.selection === "harness" || row.selection === "model")
    || row.status === "unsupported" && typeof row.operation === "string"
    || row.status === "offline" && typeof row.message === "string"
    || (row.status === "unavailable" || row.status === "upstream-error") && typeof row.message === "string" && optionalConnection) return
  throw new TypeError("Invalid execution availability")
}

export function parseExecutionAvailability(value: unknown): ExecutionAvailability | undefined {
  if (value === undefined) return undefined
  assertExecutionAvailability(value)
  return value
}
