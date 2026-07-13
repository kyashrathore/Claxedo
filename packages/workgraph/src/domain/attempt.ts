import type { AttemptDto } from "../contracts/records"
import type { ExecutionProfileProvenance } from "./execution-profile"

export interface AttemptAdmissionSnapshot {
  readonly attempt: AttemptDto
  readonly executionProvenance: ExecutionProfileProvenance
}

export function createAttemptAdmissionSnapshot(input: AttemptAdmissionSnapshot): AttemptAdmissionSnapshot {
  return deepFreeze({ attempt: input.attempt, executionProvenance: { ...input.executionProvenance } })
}

function deepFreeze<Value>(value: Value): Value {
  if (!value || typeof value !== "object") return value
  Reflect.ownKeys(value).forEach((key) => deepFreeze((value as Record<PropertyKey, unknown>)[key]))
  return Object.freeze(value)
}
