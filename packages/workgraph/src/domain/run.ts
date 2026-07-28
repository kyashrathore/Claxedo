import type { RunDto } from "../contracts/records"
import type { ExecutionProfileProvenance } from "./execution-profile"

export interface RunAdmissionSnapshot {
  readonly run: RunDto
  readonly executionProvenance: ExecutionProfileProvenance
}

export function createRunAdmissionSnapshot(input: RunAdmissionSnapshot): RunAdmissionSnapshot {
  return deepFreeze({ run: input.run, executionProvenance: { ...input.executionProvenance } })
}

function deepFreeze<Value>(value: Value): Value {
  if (!value || typeof value !== "object") return value
  Reflect.ownKeys(value).forEach((key) => deepFreeze((value as Record<PropertyKey, unknown>)[key]))
  return Object.freeze(value)
}
