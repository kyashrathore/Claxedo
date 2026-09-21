import { isRecord } from "@claxedo/helpers/guards"

export type DiagnosticsBinding = {
  pid: number
  launchId: string
  generation: string
}

export type DiagnosticsOwnerDescriptor = {
  ownerId: string
  ownerGeneration: string
  ownerOperationId: string
  launchId: string
  kind: "runtime" | "sidecar" | "pty" | "managed-process" | "session-shell" | "mcp" | "harness" | "probe" | "cli"
  role: "runtime" | "sidecar" | "pty" | "managed-process" | "session-shell" | "mcp" | "harness" | "probe" | "cli"
  label: string
  pid?: number
  parentOwnerId?: string
  workspaceId?: string
  directory?: string
  sessionId?: string
  harnessId?: string
  access?: "local" | "remote"
  attributionConfidence?: "direct" | "inferred" | "not-process-backed"
  capabilities: {
    stopGracefully: boolean
    killOwnedTree: boolean
  }
}

export type DiagnosticsOwnerEvent =
  | {
      type: "owner-registered"
      at: number
      binding: DiagnosticsBinding
      descriptor: DiagnosticsOwnerDescriptor
    }
  | {
      type: "owner-updated"
      at: number
      binding: DiagnosticsBinding
      ownerId: string
      ownerGeneration: string
      pid?: number
      lifecycle: "starting" | "ready" | "detached"
    }
  | {
      type: "owner-exited"
      at: number
      binding: DiagnosticsBinding
      ownerId: string
      ownerGeneration: string
      reason: "exited" | "error" | "timeout" | "cancelled" | "disposed" | "detached"
      exitCode?: number
      observedLifetimeMs: number
    }

export type DiagnosticsOperationRequest = {
  type: "owner-operation-request"
  binding: DiagnosticsBinding
  requestId: string
  ownerOperationId: string
  ownerGeneration: string
  operation: "stop" | "kill"
  identity: {
    pid: number
    creation: string
  }
}

export const DIAGNOSTICS_OPERATION_OUTCOMES = [
  "completed",
  "unresolved",
  "owner-unavailable",
  "operation-unavailable",
  "identity-mismatch",
  "operation-failed",
  "duplicate-request",
] as const

export type DiagnosticsOperationOutcome = (typeof DIAGNOSTICS_OPERATION_OUTCOMES)[number]

export const RETIREMENT_LEADER_STATES = ["exited", "alive", "unknown"] as const
export const RETIREMENT_DESCENDANT_STATES = ["verified_clear", "owned", "unknown"] as const

/**
 * The two halves of a retirement a renderer can act on: whether the process
 * itself is gone, and whether anything it started still is. The signals and
 * error text behind them stay on the owner's side; a renderer decides what to
 * offer, not what to print from a log line.
 */
export type DiagnosticsRetirement = {
  leader: (typeof RETIREMENT_LEADER_STATES)[number]
  descendants: (typeof RETIREMENT_DESCENDANT_STATES)[number]
}

export type DiagnosticsOperationResult = {
  type: "owner-operation-result"
  binding: DiagnosticsBinding
  requestId: string
  result: DiagnosticsOperationOutcome
  /** Absent when nothing observed the process, which is never a stop that happened. */
  retirement?: DiagnosticsRetirement
}

export type DiagnosticsTransportMessage =
  | DiagnosticsOwnerEvent
  | DiagnosticsOperationRequest
  | DiagnosticsOperationResult

/**
 * One named validator per message shape, in the same style as `binding()` and
 * `descriptor()` below.
 *
 * These used to be inline in the parser, which then asserted `input as
 * DiagnosticsOwnerEvent` on the way out — an assertion the checks above it had
 * already earned but could not express, because `input` is a
 * `Record<string, unknown>` and TypeScript does not accumulate per-property
 * narrowings into a union member. Written as type predicates, the same checks
 * ARE the proof, so the parser below carries no assertion at all.
 */
type OwnerEventOf<T extends DiagnosticsOwnerEvent["type"]> = Extract<DiagnosticsOwnerEvent, { type: T }>

function ownerRegistered(input: unknown): input is OwnerEventOf<"owner-registered"> {
  return (
    isRecord(input) &&
    exact(input, ["type", "at", "binding", "descriptor"]) &&
    timestamp(input.at) &&
    binding(input.binding) &&
    descriptor(input.descriptor)
  )
}

function ownerUpdated(input: unknown): input is OwnerEventOf<"owner-updated"> {
  return (
    isRecord(input) &&
    exactOptional(input, ["type", "at", "binding", "ownerId", "ownerGeneration", "lifecycle"], ["pid"]) &&
    timestamp(input.at) &&
    binding(input.binding) &&
    identifier(input.ownerId) &&
    identifier(input.ownerGeneration) &&
    oneOf(input.lifecycle, ["starting", "ready", "detached"]) &&
    (input.pid === undefined || pid(input.pid))
  )
}

function ownerExited(input: unknown): input is OwnerEventOf<"owner-exited"> {
  return (
    isRecord(input) &&
    exactOptional(
      input,
      ["type", "at", "binding", "ownerId", "ownerGeneration", "reason", "observedLifetimeMs"],
      ["exitCode"],
    ) &&
    timestamp(input.at) &&
    binding(input.binding) &&
    identifier(input.ownerId) &&
    identifier(input.ownerGeneration) &&
    oneOf(input.reason, ["exited", "error", "timeout", "cancelled", "disposed", "detached"]) &&
    timestamp(input.observedLifetimeMs) &&
    (input.exitCode === undefined || integer(input.exitCode))
  )
}

function operationRequest(input: unknown): input is DiagnosticsOperationRequest {
  return (
    isRecord(input) &&
    exact(input, ["type", "binding", "requestId", "ownerOperationId", "ownerGeneration", "operation", "identity"]) &&
    binding(input.binding) &&
    identifier(input.requestId) &&
    identifier(input.ownerOperationId) &&
    identifier(input.ownerGeneration) &&
    oneOf(input.operation, ["stop", "kill"]) &&
    identity(input.identity)
  )
}

function operationResult(input: unknown): input is DiagnosticsOperationResult {
  return (
    isRecord(input) &&
    exactOptional(input, ["type", "binding", "requestId", "result"], ["retirement"]) &&
    binding(input.binding) &&
    identifier(input.requestId) &&
    oneOf(input.result, DIAGNOSTICS_OPERATION_OUTCOMES) &&
    (input.retirement === undefined || retirement(input.retirement))
  )
}

function retirement(input: unknown): input is DiagnosticsRetirement {
  return (
    isRecord(input) &&
    exact(input, ["leader", "descendants"]) &&
    oneOf(input.leader, RETIREMENT_LEADER_STATES) &&
    oneOf(input.descendants, RETIREMENT_DESCENDANT_STATES)
  )
}

export function parseDiagnosticsTransportMessage(input: unknown):
  | { success: true; data: DiagnosticsTransportMessage }
  | { success: false; error: string } {
  if (!isRecord(input)) return invalid()
  switch (input.type) {
    case "owner-registered":
      return ownerRegistered(input) ? valid(input) : invalid()
    case "owner-updated":
      return ownerUpdated(input) ? valid(input) : invalid()
    case "owner-exited":
      return ownerExited(input) ? valid(input) : invalid()
    case "owner-operation-request":
      return operationRequest(input) ? valid(input) : invalid()
    case "owner-operation-result":
      return operationResult(input) ? valid(input) : invalid()
    default:
      return invalid()
  }
}

export function matchesDiagnosticsBinding(binding: DiagnosticsBinding, expected: DiagnosticsBinding) {
  return (
    binding.pid === expected.pid &&
    binding.launchId === expected.launchId &&
    binding.generation === expected.generation
  )
}

function descriptor(input: unknown): input is DiagnosticsOwnerDescriptor {
  if (!isRecord(input)) return false
  if (
    !exactOptional(
      input,
      [
        "ownerId",
        "ownerGeneration",
        "ownerOperationId",
        "launchId",
        "kind",
        "role",
        "label",
        "capabilities",
      ],
      [
        "pid",
        "parentOwnerId",
        "workspaceId",
        "directory",
        "sessionId",
        "harnessId",
        "access",
        "attributionConfidence",
      ],
    )
  ) return false
  if (
    !identifier(input.ownerId) ||
    !identifier(input.ownerGeneration) ||
    !identifier(input.ownerOperationId) ||
    !identifier(input.launchId) ||
    !oneOf(input.kind, ["runtime", "sidecar", "pty", "managed-process", "session-shell", "mcp", "harness", "probe", "cli"]) ||
    !oneOf(input.role, ["runtime", "sidecar", "pty", "managed-process", "session-shell", "mcp", "harness", "probe", "cli"]) ||
    input.role !== input.kind ||
    !identifier(input.label) ||
    (input.pid !== undefined && !pid(input.pid)) ||
    (input.parentOwnerId !== undefined && !identifier(input.parentOwnerId)) ||
    (input.workspaceId !== undefined && !identifier(input.workspaceId)) ||
    (input.directory !== undefined && !text(input.directory, 4_096)) ||
    (input.sessionId !== undefined && !identifier(input.sessionId)) ||
    (input.harnessId !== undefined && !identifier(input.harnessId)) ||
    (input.access !== undefined && !oneOf(input.access, ["local", "remote"])) ||
    (
      input.attributionConfidence !== undefined &&
      !oneOf(input.attributionConfidence, ["direct", "inferred", "not-process-backed"])
    ) ||
    !isRecord(input.capabilities) ||
    !exact(input.capabilities, ["stopGracefully", "killOwnedTree"]) ||
    typeof input.capabilities.stopGracefully !== "boolean" ||
    typeof input.capabilities.killOwnedTree !== "boolean"
  ) return false
  return true
}

function binding(input: unknown): input is DiagnosticsBinding {
  return (
    isRecord(input) &&
    exact(input, ["pid", "launchId", "generation"]) &&
    pid(input.pid) &&
    identifier(input.launchId) &&
    identifier(input.generation)
  )
}

function identity(input: unknown) {
  return (
    isRecord(input) &&
    exact(input, ["pid", "creation"]) &&
    pid(input.pid) &&
    identifier(input.creation)
  )
}

function valid<T extends DiagnosticsTransportMessage>(data: T) {
  return { success: true as const, data }
}

function invalid() {
  return { success: false as const, error: "invalid-diagnostics-transport-message" }
}

function exact(input: Record<string, unknown>, required: string[]) {
  return exactOptional(input, required, [])
}

function exactOptional(input: Record<string, unknown>, required: string[], optional: string[]) {
  const keys = Object.keys(input)
  return required.every((key) => key in input) && keys.every((key) => required.includes(key) || optional.includes(key))
}

function oneOf<T extends string>(input: unknown, values: readonly T[]): input is T {
  return typeof input === "string" && values.some((value) => value === input)
}

function text(input: unknown, max: number): input is string {
  return typeof input === "string" && input.length > 0 && input.length <= max
}

function identifier(input: unknown): input is string {
  return text(input, 256)
}

function integer(input: unknown): input is number {
  return typeof input === "number" && Number.isInteger(input)
}

function timestamp(input: unknown): input is number {
  return integer(input) && input >= 0
}

function pid(input: unknown): input is number {
  return integer(input) && input > 0
}
