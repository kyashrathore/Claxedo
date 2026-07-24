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

export type DiagnosticsOperationResult = {
  type: "owner-operation-result"
  binding: DiagnosticsBinding
  requestId: string
  result:
    | "completed"
    | "owner-unavailable"
    | "operation-unavailable"
    | "identity-mismatch"
    | "operation-failed"
    | "duplicate-request"
}

export type DiagnosticsTransportMessage =
  | DiagnosticsOwnerEvent
  | DiagnosticsOperationRequest
  | DiagnosticsOperationResult

export function parseDiagnosticsTransportMessage(input: unknown):
  | { success: true; data: DiagnosticsTransportMessage }
  | { success: false; error: string } {
  if (!record(input) || typeof input.type !== "string") return invalid()
  if (input.type === "owner-registered") {
    if (!exact(input, ["type", "at", "binding", "descriptor"])) return invalid()
    if (!timestamp(input.at) || !binding(input.binding) || !descriptor(input.descriptor)) return invalid()
    return valid(input as DiagnosticsOwnerEvent)
  }
  if (input.type === "owner-updated") {
    if (!exactOptional(input, ["type", "at", "binding", "ownerId", "ownerGeneration", "lifecycle"], ["pid"])) {
      return invalid()
    }
    if (
      !timestamp(input.at) ||
      !binding(input.binding) ||
      !identifier(input.ownerId) ||
      !identifier(input.ownerGeneration) ||
      !oneOf(input.lifecycle, ["starting", "ready", "detached"]) ||
      (input.pid !== undefined && !pid(input.pid))
    ) return invalid()
    return valid(input as DiagnosticsOwnerEvent)
  }
  if (input.type === "owner-exited") {
    if (
      !exactOptional(
        input,
        ["type", "at", "binding", "ownerId", "ownerGeneration", "reason", "observedLifetimeMs"],
        ["exitCode"],
      )
    ) return invalid()
    if (
      !timestamp(input.at) ||
      !binding(input.binding) ||
      !identifier(input.ownerId) ||
      !identifier(input.ownerGeneration) ||
      !oneOf(input.reason, ["exited", "error", "timeout", "cancelled", "disposed", "detached"]) ||
      !timestamp(input.observedLifetimeMs) ||
      (input.exitCode !== undefined && !integer(input.exitCode))
    ) return invalid()
    return valid(input as DiagnosticsOwnerEvent)
  }
  if (input.type === "owner-operation-request") {
    if (
      !exact(input, [
        "type",
        "binding",
        "requestId",
        "ownerOperationId",
        "ownerGeneration",
        "operation",
        "identity",
      ])
    ) return invalid()
    if (
      !binding(input.binding) ||
      !identifier(input.requestId) ||
      !identifier(input.ownerOperationId) ||
      !identifier(input.ownerGeneration) ||
      !oneOf(input.operation, ["stop", "kill"]) ||
      !identity(input.identity)
    ) return invalid()
    return valid(input as DiagnosticsOperationRequest)
  }
  if (input.type === "owner-operation-result") {
    if (!exact(input, ["type", "binding", "requestId", "result"])) return invalid()
    if (
      !binding(input.binding) ||
      !identifier(input.requestId) ||
      !oneOf(input.result, [
        "completed",
        "owner-unavailable",
        "operation-unavailable",
        "identity-mismatch",
        "operation-failed",
        "duplicate-request",
      ])
    ) return invalid()
    return valid(input as DiagnosticsOperationResult)
  }
  return invalid()
}

export function matchesDiagnosticsBinding(binding: DiagnosticsBinding, expected: DiagnosticsBinding) {
  return (
    binding.pid === expected.pid &&
    binding.launchId === expected.launchId &&
    binding.generation === expected.generation
  )
}

function descriptor(input: unknown): input is DiagnosticsOwnerDescriptor {
  if (!record(input)) return false
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
    !record(input.capabilities) ||
    !exact(input.capabilities, ["stopGracefully", "killOwnedTree"]) ||
    typeof input.capabilities.stopGracefully !== "boolean" ||
    typeof input.capabilities.killOwnedTree !== "boolean"
  ) return false
  return true
}

function binding(input: unknown): input is DiagnosticsBinding {
  return (
    record(input) &&
    exact(input, ["pid", "launchId", "generation"]) &&
    pid(input.pid) &&
    identifier(input.launchId) &&
    identifier(input.generation)
  )
}

function identity(input: unknown) {
  return (
    record(input) &&
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

function record(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input)
}

function exact(input: Record<string, unknown>, required: string[]) {
  return exactOptional(input, required, [])
}

function exactOptional(input: Record<string, unknown>, required: string[], optional: string[]) {
  const keys = Object.keys(input)
  return required.every((key) => key in input) && keys.every((key) => required.includes(key) || optional.includes(key))
}

function oneOf<T extends string>(input: unknown, values: readonly T[]): input is T {
  return typeof input === "string" && values.includes(input as T)
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
