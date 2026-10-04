import { asText } from "../values"
import { asFiniteNumber } from "@claxedo/helpers/guards"

export const RECOVERY_CONTRACT_ERROR_CODES = [
  "invalid_payload",
  "invalid_request_id",
  "invalid_action",
  "invalid_attempt",
  "invalid_scope_revision",
  "invalid_target",
  "invalid_target_scope",
  "scope_mismatch",
  "missing_generation",
  "invalid_observed_at",
  "invalid_fact",
  "invalid_operation",
  "invalid_refusal",
  "invalid_budget",
] as const

export type RecoveryContractErrorCode = (typeof RECOVERY_CONTRACT_ERROR_CODES)[number]

export class RecoveryContractError extends Error {
  constructor(readonly code: RecoveryContractErrorCode, message: string) {
    super(message)
    this.name = "RecoveryContractError"
  }
}

export function member<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value)
}

export function requireRecoveryText(value: unknown, code: RecoveryContractErrorCode, label: string): string {
  const found = asText(value)
  if (found === undefined) throw new RecoveryContractError(code, `recovery ${label} must be a non-empty string`)
  return found
}

export function requireRecoveryNumber(value: unknown, code: RecoveryContractErrorCode, label: string): number {
  const found = asFiniteNumber(value)
  if (found === undefined) throw new RecoveryContractError(code, `recovery ${label} must be a finite number`)
  return found
}
