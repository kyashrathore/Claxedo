/**
 * Fixed Electron-main <-> Host Connector child protocol.
 *
 * The private key and named account-operation results cross only Electron's
 * parent/utility-process message port. They are never process arguments,
 * environment variables, renderer IPC values, or log fields.
 */

import { asRecord, isNonEmptyString, readUnknown } from "../../shared/json-read"

export type HostConnectorChildState =
  | { status: "idle" }
  | {
      status: "enrolled"
      enrollment: { enrollment_id: string; host_id: string; expires_at: number }
      /** Workspaces this machine currently publishes (live local-host links). */
      sharedWorkspaceIds?: readonly string[]
    }
  | { status: "stopped"; reason: "revoked" | "error" | "closed"; detail: string }

export const HOST_ENROLLMENT_OPERATIONS = {
  createRequest: "host.enrollmentNonce",
  enroll: "host.enrollCurrentMachine",
  // One signed beat per interval carries the lease renewal AND the served
  // workspace set (heartbeat payload v2); its response carries the owner's
  // assignment view and the serving credentials. The child owns it because
  // it is the only process holding the machine key.
  heartbeat: "host.enrollmentHeartbeat",
} as const

export type HostEnrollmentOperation = (typeof HOST_ENROLLMENT_OPERATIONS)[keyof typeof HOST_ENROLLMENT_OPERATIONS]

export type HostConnectorBootstrapIdentity = {
  hostId: string
  privateKeyJwk: JsonWebKey
}

export type HostConnectorSharedWorkspace = { workspaceId: string; displayName?: string }

export type HostConnectorParentMessage =
  | {
      type: "bootstrap"
      requestId: string
      identity?: HostConnectorBootstrapIdentity
      displayName?: string
      heartbeatIntervalMs: number
      /**
       * How the DAEMON's workspace runtimes composed their session access.
       *
       * The child signs and sends every heartbeat, but it is not the process
       * that composed the runtimes it beats for — the daemon is — so the
       * answer travels here with the rest of the bootstrap. A client reads
       * from this declaration whether a session it creates on this machine
       * must be registered with the control plane first, and never infers
       * it; a bootstrap that omits it publishes a machine whose clients
       * create sessions unregistered.
       */
      sessionAuthority?: "local" | "managed-private"
      /** Shares to re-establish after enrollment (registration is an upsert). */
      sharedWorkspaces?: readonly HostConnectorSharedWorkspace[]
    }
  | { type: "share-workspace"; requestId: string; workspaceId: string; displayName?: string }
  | { type: "unshare-workspace"; requestId: string; workspaceId: string }
  | { type: "identity-stored"; requestId: string }
  | { type: "account-result"; requestId: string; ok: true; value: unknown }
  | { type: "account-result"; requestId: string; ok: false; error: string }
  | { type: "stop"; requestId: string }

export type HostConnectorChildMessage =
  | { type: "ready" }
  /**
   * The serving credential from the latest heartbeat ack: ONE Host Tunnel
   * token whose claim covers every workspace this machine is currently
   * routable for, or null when nothing is. The parent forwards it to the
   * daemon, which owns the relay connection.
   */
  | { type: "serving"; tunnel: Record<string, unknown> | null }
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

function requestId(input: Record<string, unknown>): string | undefined {
  return isNonEmptyString(input.requestId) ? input.requestId : undefined
}

/**
 * The one JWK guard for this protocol.
 *
 * `JsonWebKey` declares every member optional, so there is no shape to check
 * beyond the key type; callers that need the PRIVATE material check `d`
 * themselves (see `identity-store.ts`).
 */
export function isJsonWebKey(value: unknown): value is JsonWebKey {
  return isNonEmptyString(readUnknown(value, "kty"))
}

function identity(value: unknown): HostConnectorBootstrapIdentity | undefined {
  const input = asRecord(value)
  if (!input || !isNonEmptyString(input.hostId) || !isJsonWebKey(input.privateKeyJwk)) return undefined
  return { hostId: input.hostId, privateKeyJwk: input.privateKeyJwk }
}

function connectorState(value: unknown): HostConnectorChildState | undefined {
  const input = asRecord(value)
  if (!input) return undefined
  if (input.status === "idle") return { status: "idle" }
  if (input.status === "enrolled") {
    const enrollment = asRecord(input.enrollment)
    if (
      !enrollment ||
      !isNonEmptyString(enrollment.enrollment_id) ||
      !isNonEmptyString(enrollment.host_id) ||
      typeof enrollment.expires_at !== "number" ||
      !Number.isFinite(enrollment.expires_at)
    ) {
      return undefined
    }
    const shared = Array.isArray(input.sharedWorkspaceIds)
      && input.sharedWorkspaceIds.every((entry) => isNonEmptyString(entry))
      ? (input.sharedWorkspaceIds)
      : undefined
    if (input.sharedWorkspaceIds !== undefined && !shared) return undefined
    return {
      status: "enrolled",
      enrollment: {
        enrollment_id: enrollment.enrollment_id,
        host_id: enrollment.host_id,
        expires_at: enrollment.expires_at,
      },
      ...(shared ? { sharedWorkspaceIds: shared } : {}),
    }
  }
  if (input.status === "stopped") {
    if (
      (input.reason !== "revoked" && input.reason !== "error" && input.reason !== "closed") ||
      typeof input.detail !== "string"
    ) {
      return undefined
    }
    return { status: "stopped", reason: input.reason, detail: input.detail }
  }
  return undefined
}

export function parseHostConnectorParentMessage(value: unknown): HostConnectorParentMessage | undefined {
  const input = asRecord(value)
  if (!input || !isNonEmptyString(input.type)) return undefined

  if (input.type === "bootstrap") {
    const id = requestId(input)
    if (!id || typeof input.heartbeatIntervalMs !== "number" || !Number.isFinite(input.heartbeatIntervalMs)) return undefined
    const restored = input.identity === undefined ? undefined : identity(input.identity)
    if (input.identity !== undefined && !restored) return undefined
    if (input.displayName !== undefined && typeof input.displayName !== "string") return undefined
    const shares = input.sharedWorkspaces === undefined
      ? undefined
      : Array.isArray(input.sharedWorkspaces)
        ? input.sharedWorkspaces.flatMap((entry) => {
            const share = asRecord(entry)
            if (!share || !isNonEmptyString(share.workspaceId)) return []
            if (share.displayName !== undefined && typeof share.displayName !== "string") return []
            return [{
              workspaceId: share.workspaceId,
              ...(typeof share.displayName === "string" ? { displayName: share.displayName } : {}),
            }]
          })
        : undefined
    if (input.sharedWorkspaces !== undefined && shares === undefined) return undefined
    const sessionAuthority = input.sessionAuthority === "local" || input.sessionAuthority === "managed-private"
      ? input.sessionAuthority
      : undefined
    if (input.sessionAuthority !== undefined && sessionAuthority === undefined) return undefined
    return {
      type: "bootstrap",
      requestId: id,
      heartbeatIntervalMs: input.heartbeatIntervalMs,
      ...(restored ? { identity: restored } : {}),
      ...(typeof input.displayName === "string" ? { displayName: input.displayName } : {}),
      ...(sessionAuthority ? { sessionAuthority } : {}),
      ...(shares ? { sharedWorkspaces: shares } : {}),
    }
  }

  if (input.type === "share-workspace") {
    const id = requestId(input)
    if (!id || !isNonEmptyString(input.workspaceId)) return undefined
    if (input.displayName !== undefined && typeof input.displayName !== "string") return undefined
    return {
      type: "share-workspace",
      requestId: id,
      workspaceId: input.workspaceId,
      ...(typeof input.displayName === "string" ? { displayName: input.displayName } : {}),
    }
  }

  if (input.type === "unshare-workspace") {
    const id = requestId(input)
    if (!id || !isNonEmptyString(input.workspaceId)) return undefined
    return { type: "unshare-workspace", requestId: id, workspaceId: input.workspaceId }
  }

  if (input.type === "identity-stored" || input.type === "stop") {
    const id = requestId(input)
    return id ? { type: input.type, requestId: id } : undefined
  }

  if (input.type === "account-result") {
    const id = requestId(input)
    if (!id || typeof input.ok !== "boolean") return undefined
    return input.ok
      ? { type: "account-result", requestId: id, ok: true, value: input.value }
      : typeof input.error === "string"
        ? { type: "account-result", requestId: id, ok: false, error: input.error }
        : undefined
  }

  return undefined
}

export function parseHostConnectorChildMessage(value: unknown): HostConnectorChildMessage | undefined {
  const input = asRecord(value)
  if (!input || !isNonEmptyString(input.type)) return undefined
  if (input.type === "ready") return { type: "ready" }

  if (input.type === "serving") {
    if (input.tunnel === null) return { type: "serving", tunnel: null }
    const tunnel = asRecord(input.tunnel)
    return tunnel ? { type: "serving", tunnel } : undefined
  }

  if (input.type === "identity-created") {
    const id = requestId(input)
    const created = identity(input.identity)
    return id && created ? { type: "identity-created", requestId: id, identity: created } : undefined
  }

  if (input.type === "account-operation") {
    const id = requestId(input)
    const operation = Object.values(HOST_ENROLLMENT_OPERATIONS).find((name) => name === input.name)
    const operationInput = input.input === undefined ? undefined : asRecord(input.input)
    if (!id || !operation || (input.input !== undefined && !operationInput)) return undefined
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
    if (!id || typeof input.ok !== "boolean") return undefined
    if (!input.ok) return typeof input.error === "string" ? { type: "response", requestId: id, ok: false, error: input.error } : undefined
    const status = connectorState(input.status)
    return status ? { type: "response", requestId: id, ok: true, status } : undefined
  }

  return undefined
}
