/**
 * Fixed Electron-main <-> Host Connector child protocol.
 *
 * The private key and named account-operation results cross only Electron's
 * parent/utility-process message port. They are never process arguments,
 * environment variables, renderer IPC values, or log fields.
 */

export type HostConnectorChildState =
  | { status: "idle" }
  | {
      status: "enrolled"
      enrollment: { enrollment_id: string; host_id: string; expires_at: number }
    }
  | { status: "stopped"; reason: "revoked" | "error" | "closed"; detail: string }

export const HOST_ENROLLMENT_OPERATIONS = {
  createRequest: "host.enrollmentNonce",
  enroll: "host.enrollCurrentMachine",
  heartbeat: "host.enrollmentHeartbeat",
} as const

export type HostEnrollmentOperation = (typeof HOST_ENROLLMENT_OPERATIONS)[keyof typeof HOST_ENROLLMENT_OPERATIONS]

export type HostConnectorBootstrapIdentity = {
  hostId: string
  privateKeyJwk: JsonWebKey
}

export type HostConnectorParentMessage =
  | {
      type: "bootstrap"
      requestId: string
      identity?: HostConnectorBootstrapIdentity
      displayName?: string
      heartbeatIntervalMs: number
    }
  | { type: "identity-stored"; requestId: string }
  | { type: "account-result"; requestId: string; ok: true; value: unknown }
  | { type: "account-result"; requestId: string; ok: false; error: string }
  | { type: "stop"; requestId: string }

export type HostConnectorChildMessage =
  | { type: "ready" }
  | { type: "identity-created"; requestId: string; identity: HostConnectorBootstrapIdentity }
  | {
      type: "account-operation"
      requestId: string
      name: HostEnrollmentOperation
      input?: Record<string, unknown>
    }
  | { type: "status"; status: HostConnectorChildState }
  | { type: "response"; requestId: string; ok: true; status: HostConnectorChildState }
  | { type: "response"; requestId: string; ok: false; error: string }

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function requestId(input: Record<string, unknown>): string | undefined {
  return nonemptyString(input.requestId) ? input.requestId : undefined
}

function isJwk(value: unknown): value is JsonWebKey {
  const input = record(value)
  return !!input && nonemptyString(input.kty)
}

function identity(value: unknown): HostConnectorBootstrapIdentity | undefined {
  const input = record(value)
  if (!input || !nonemptyString(input.hostId) || !isJwk(input.privateKeyJwk)) return
  return { hostId: input.hostId, privateKeyJwk: input.privateKeyJwk }
}

function connectorState(value: unknown): HostConnectorChildState | undefined {
  const input = record(value)
  if (!input || !nonemptyString(input.status)) return
  if (input.status === "idle") return { status: "idle" }
  if (input.status === "enrolled") {
    const enrollment = record(input.enrollment)
    if (
      !enrollment ||
      !nonemptyString(enrollment.enrollment_id) ||
      !nonemptyString(enrollment.host_id) ||
      typeof enrollment.expires_at !== "number" ||
      !Number.isFinite(enrollment.expires_at)
    ) {
      return
    }
    return {
      status: "enrolled",
      enrollment: {
        enrollment_id: enrollment.enrollment_id,
        host_id: enrollment.host_id,
        expires_at: enrollment.expires_at,
      },
    }
  }
  if (input.status === "stopped") {
    if (
      (input.reason !== "revoked" && input.reason !== "error" && input.reason !== "closed") ||
      typeof input.detail !== "string"
    ) {
      return
    }
    return { status: "stopped", reason: input.reason, detail: input.detail }
  }
}

export function parseHostConnectorParentMessage(value: unknown): HostConnectorParentMessage | undefined {
  const input = record(value)
  if (!input || !nonemptyString(input.type)) return

  if (input.type === "bootstrap") {
    const id = requestId(input)
    if (!id || typeof input.heartbeatIntervalMs !== "number" || !Number.isFinite(input.heartbeatIntervalMs)) return
    const restored = input.identity === undefined ? undefined : identity(input.identity)
    if (input.identity !== undefined && !restored) return
    if (input.displayName !== undefined && typeof input.displayName !== "string") return
    return {
      type: "bootstrap",
      requestId: id,
      heartbeatIntervalMs: input.heartbeatIntervalMs,
      ...(restored ? { identity: restored } : {}),
      ...(typeof input.displayName === "string" ? { displayName: input.displayName } : {}),
    }
  }

  if (input.type === "identity-stored" || input.type === "stop") {
    const id = requestId(input)
    return id ? { type: input.type, requestId: id } : undefined
  }

  if (input.type === "account-result") {
    const id = requestId(input)
    if (!id || typeof input.ok !== "boolean") return
    return input.ok
      ? { type: "account-result", requestId: id, ok: true, value: input.value }
      : typeof input.error === "string"
        ? { type: "account-result", requestId: id, ok: false, error: input.error }
        : undefined
  }
}

export function parseHostConnectorChildMessage(value: unknown): HostConnectorChildMessage | undefined {
  const input = record(value)
  if (!input || !nonemptyString(input.type)) return
  if (input.type === "ready") return { type: "ready" }

  if (input.type === "identity-created") {
    const id = requestId(input)
    const created = identity(input.identity)
    return id && created ? { type: "identity-created", requestId: id, identity: created } : undefined
  }

  if (input.type === "account-operation") {
    const id = requestId(input)
    const operation = Object.values(HOST_ENROLLMENT_OPERATIONS).find((name) => name === input.name)
    const operationInput = input.input === undefined ? undefined : record(input.input)
    if (!id || !operation || (input.input !== undefined && !operationInput)) return
    return {
      type: "account-operation",
      requestId: id,
      name: operation,
      ...(operationInput ? { input: operationInput } : {}),
    }
  }

  if (input.type === "status") {
    const status = connectorState(input.status)
    return status ? { type: "status", status } : undefined
  }

  if (input.type === "response") {
    const id = requestId(input)
    if (!id || typeof input.ok !== "boolean") return
    if (!input.ok) return typeof input.error === "string" ? { type: "response", requestId: id, ok: false, error: input.error } : undefined
    const status = connectorState(input.status)
    return status ? { type: "response", requestId: id, ok: true, status } : undefined
  }
}
