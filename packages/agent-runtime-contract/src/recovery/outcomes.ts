import { asRecord } from "../values"
import { type RecoveryOperation, parseRecoveryOperation } from "./operations"
import { type RecoveryTarget, parseRecoveryTarget } from "./targets"
import { RecoveryContractError, requireRecoveryText, requireRecoveryNumber } from "./validation"

/** The sessions and resources an escalation would interrupt, named individually. */
export type RecoveryScopePreview = {
  sessions: string[]
  resources: string[]
  summary: string
}

export type RecoveryRefusal =
  | { kind: "generation_conflict"; message: string; current?: RecoveryTarget }
  | { kind: "intent_conflict"; message: string; requestId: string }
  | { kind: "receipt_expired"; message: string; requestId: string }
  | { kind: "scope_changed"; message: string; scopeRevision: string; preview: RecoveryScopePreview }
  | { kind: "unauthorized"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "version_update_required"; message: string; contractVersion: number }

export type RecoveryOutcome =
  | { kind: "operation"; operation: RecoveryOperation }
  | { kind: "refused"; refusal: RecoveryRefusal }

export function parseRecoveryRefusal(input: unknown): RecoveryRefusal {
  const row = asRecord(input)
  if (!row) throw new RecoveryContractError("invalid_refusal", "recovery refusal must be an object")
  const message = requireRecoveryText(row.message, "invalid_refusal", "message")
  switch (row.kind) {
    case "generation_conflict":
      return {
        kind: "generation_conflict",
        message,
        ...(row.current !== undefined ? { current: parseRecoveryTarget(row.current) } : {}),
      }
    case "intent_conflict":
    case "receipt_expired":
      return { kind: row.kind, message, requestId: requireRecoveryText(row.requestId, "invalid_request_id", "requestId") }
    case "scope_changed":
      return {
        kind: "scope_changed",
        message,
        scopeRevision: requireRecoveryText(row.scopeRevision, "invalid_scope_revision", "scopeRevision"),
        preview: parseScopePreview(row.preview),
      }
    case "unauthorized":
    case "unavailable":
      return { kind: row.kind, message }
    case "version_update_required":
      return {
        kind: "version_update_required",
        message,
        contractVersion: requireRecoveryNumber(row.contractVersion, "invalid_refusal", "contractVersion"),
      }
    default:
      throw new RecoveryContractError("invalid_refusal", `unknown recovery refusal ${JSON.stringify(row.kind)}`)
  }
}

export function serializeRecoveryOutcome(outcome: RecoveryOutcome): string {
  return JSON.stringify(outcome)
}

/** Accepts the HTTP body as text or an already decoded IPC value. */
export function parseRecoveryOutcome(input: unknown): RecoveryOutcome {
  if (typeof input !== "string") return decodeOutcome(input)
  try {
    return decodeOutcome(JSON.parse(input))
  } catch (error) {
    if (error instanceof RecoveryContractError) throw error
    throw new RecoveryContractError("invalid_payload", "recovery outcome is not valid JSON")
  }
}

export function isRecoveryOutcome(value: unknown): value is RecoveryOutcome {
  try {
    decodeOutcome(value)
    return true
  } catch (error) {
    if (error instanceof RecoveryContractError) return false
    throw error
  }
}

function decodeOutcome(value: unknown): RecoveryOutcome {
  const row = asRecord(value)
  if (!row) throw new RecoveryContractError("invalid_payload", "recovery outcome must be an object")
  if (row.kind === "operation") return { kind: "operation", operation: parseRecoveryOperation(row.operation) }
  if (row.kind === "refused") return { kind: "refused", refusal: parseRecoveryRefusal(row.refusal) }
  throw new RecoveryContractError("invalid_payload", `unknown recovery outcome ${JSON.stringify(row.kind)}`)
}

function parseScopePreview(input: unknown): RecoveryScopePreview {
  const row = asRecord(input)
  if (!row || !Array.isArray(row.sessions) || !Array.isArray(row.resources)) {
    throw new RecoveryContractError("invalid_refusal", "recovery scope preview requires sessions and resources")
  }
  return {
    sessions: row.sessions.map((value) => requireRecoveryText(value, "invalid_refusal", "session")),
    resources: row.resources.map((value) => requireRecoveryText(value, "invalid_refusal", "resource")),
    summary: requireRecoveryText(row.summary, "invalid_refusal", "summary"),
  }
}
