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
      /** Workspaces this machine has acked at the owner's current revision, so the control plane routes them here. */
      sharedWorkspaceIds?: readonly string[]
    }
  | { status: "stopped"; reason: "revoked" | "error" | "closed"; detail: string }

/**
 * The whole account surface the child reaches through main: the enrollment
 * handshake, and nothing after it. From the `enrollment_id` onward the child
 * signs its own requests with the machine key and talks to the control plane
 * directly, so no beat spends the owner's credential.
 */
export const HOST_ENROLLMENT_OPERATIONS = {
  createRequest: "host.enrollmentNonce",
  enroll: "host.enrollCurrentMachine",
} as const

export type HostEnrollmentOperation = (typeof HOST_ENROLLMENT_OPERATIONS)[keyof typeof HOST_ENROLLMENT_OPERATIONS]

export type HostConnectorBootstrapIdentity = {
  hostId: string
  privateKeyJwk: JsonWebKey
  /**
   * The ECDH half the control plane seals provider credentials for. Absent
   * from a record written before machines could receive one; the child mints
   * it on bootstrap and hands it back through `sealing-key-created`.
   */
  sealingPrivateKeyJwk?: JsonWebKey
}

/**
 * One provider-configuration revision as the control plane delivered it:
 * ciphertext only, or `null` for the withdrawal. Main persists this verbatim
 * and never opens it — the sealing key lives in the child.
 */
export type HostConnectorProviderConfig = { revision: number; sealed: string | null }

/**
 * The same revision, opened: the plaintext JSON text of the sealed payload
 * (`{"version":1,"providers":{...}}`), which main forwards to the daemon and
 * never parses.
 */
export type HostConnectorProviderConfigReady = { revision: number; providers: string }

export type HostConnectorSharedWorkspace = { workspaceId: string; displayName?: string }

/**
 * The two addresses a heartbeat ack names, in the shape the daemon's serving
 * route accepts: the relay's published key set, against which the daemon
 * verifies a relayed caller's Relay Host Token, and the control plane's
 * session authority, which decides whether that caller may read a session.
 *
 * Flattened here rather than carried in the connector's own nested form
 * because main only forwards them, and main's import closure deliberately
 * never reaches the connector package — `host-connector-boundary.test.ts`
 * holds that line, `import type` included.
 */
export type HostConnectorServingEndpoints = {
  relayJwksUrl?: string
  sessionAuthorityUrl?: string
}

/**
 * Everything one heartbeat ack says about serving.
 *
 * The credential and the endpoints travel together because the daemon needs
 * both before the tunnel opens: a relayed request can arrive the moment it
 * does, and a daemon holding the credential alone answers 503 to every
 * relayed session read.
 */
export type HostConnectorServing = {
  /**
   * ONE Host Tunnel token whose claim covers every workspace this machine is
   * currently routable for, or null when nothing is.
   */
  tunnel: Record<string, unknown> | null
  endpoints?: HostConnectorServingEndpoints
}

export type HostConnectorParentMessage =
  | {
      type: "bootstrap"
      requestId: string
      identity?: HostConnectorBootstrapIdentity
      displayName?: string
      heartbeatIntervalMs: number
      /**
       * Where this machine beats, once it is enrolled.
       *
       * The child holds the machine key, so from the enrollment onward it
       * signs and sends its own requests instead of asking main to spend the
       * account on them — and it has no way to learn the deployment it was
       * enrolled against. Main does: the account is bound to exactly one
       * control-plane origin.
       */
      controlPlaneUrl: string
      /**
       * How the DAEMON's workspace runtimes composed their session access.
       *
       * The child signs and sends every heartbeat, but it is not the process
       * that composed the runtimes it beats for — the daemon is — so the
       * answer travels here with the rest of the bootstrap. A client of this
       * machine reads from this declaration whether a session it creates
       * here must be registered with the control plane first (a client on
       * the hosted plane registers regardless); a bootstrap that omits it
       * publishes a machine whose local clients create sessions unregistered.
       */
      sessionAuthority?: "local" | "managed-private"
      /** Shares to re-establish after enrollment (registration is an upsert). */
      sharedWorkspaces?: readonly HostConnectorSharedWorkspace[]
      /**
       * The revision main stored before the restart. The child declares it on
       * the first beat (so the control plane does not re-send a blob the
       * machine holds) and re-opens it for the daemon, which restarted too.
       */
      providerConfig?: HostConnectorProviderConfig
    }
  | { type: "share-workspace"; requestId: string; workspaceId: string; displayName?: string }
  | { type: "unshare-workspace"; requestId: string; workspaceId: string }
  | { type: "identity-stored"; requestId: string }
  | { type: "sealing-key-stored"; requestId: string }
  /**
   * Whether main persisted the ciphertext. `ok: false` keeps the child from
   * acking the revision, so the control plane delivers it again.
   */
  | { type: "provider-config-stored"; requestId: string; ok: true }
  | { type: "provider-config-stored"; requestId: string; ok: false; error: string }
  | { type: "account-result"; requestId: string; ok: true; value: unknown }
  | { type: "account-result"; requestId: string; ok: false; error: string }
  | { type: "stop"; requestId: string }

export type HostConnectorChildMessage =
  | { type: "ready" }
  /**
   * What the latest heartbeat ack said about serving. The parent forwards it
   * to the daemon, which owns the relay connection.
   *
   * The endpoints are the child's latest, not the latest ack's: the control
   * plane sends them only when they change, so the child restates them on
   * every message and the parent never has to remember an earlier one.
   */
  | ({ type: "serving" } & HostConnectorServing)
  | { type: "identity-created"; requestId: string; identity: HostConnectorBootstrapIdentity }
  | { type: "sealing-key-created"; requestId: string; sealingPrivateKeyJwk: JsonWebKey }
  /** A delivered revision, still sealed, for main to persist before the child acks it. */
  | ({ type: "provider-config"; requestId: string } & HostConnectorProviderConfig)
  /** The same revision opened, for main to forward to the daemon. */
  | ({ type: "provider-config-ready" } & HostConnectorProviderConfigReady)
  | {
      type: "account-operation"
      requestId: string
      name: HostEnrollmentOperation
      input?: Record<string, unknown>
    }
  /**
   * A stage the connector reported and recovered from, so the child keeps
   * running and the status alone says nothing about it. A sealed revision the
   * child cannot open is the case this exists for: the control plane's acked
   * revision simply never advances, and without this line nothing on the
   * machine names the reason.
   */
  | { type: "child-error"; stage: string; detail: string }
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
  if (input.sealingPrivateKeyJwk !== undefined && !isJsonWebKey(input.sealingPrivateKeyJwk)) return undefined
  return {
    hostId: input.hostId,
    privateKeyJwk: input.privateKeyJwk,
    ...(input.sealingPrivateKeyJwk === undefined ? {} : { sealingPrivateKeyJwk: input.sealingPrivateKeyJwk }),
  }
}

function revision(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * `sealed` is a string or the literal `null`; anything else refuses the
 * whole message. A missing field is not a withdrawal, and treating it as one
 * would let a malformed delivery empty the daemon's credentials.
 */
export function hostConnectorProviderConfig(value: unknown): HostConnectorProviderConfig | undefined {
  const input = asRecord(value)
  if (!input) return undefined
  const rev = revision(input.revision)
  if (rev === undefined) return undefined
  if (input.sealed !== null && typeof input.sealed !== "string") return undefined
  return { revision: rev, sealed: input.sealed }
}

/**
 * Answers `undefined` for a record naming neither address as well as for a
 * malformed one, so a `serving` message carrying an unreadable `endpoints` is
 * rejected whole rather than forwarded with the field quietly dropped — the
 * daemon would then hold a credential it cannot admit anyone against.
 */
function servingEndpoints(value: unknown): HostConnectorServingEndpoints | undefined {
  const input = asRecord(value)
  if (!input) return undefined
  const relayJwksUrl = input.relayJwksUrl
  const sessionAuthorityUrl = input.sessionAuthorityUrl
  if (relayJwksUrl !== undefined && !isNonEmptyString(relayJwksUrl)) return undefined
  if (sessionAuthorityUrl !== undefined && !isNonEmptyString(sessionAuthorityUrl)) return undefined
  if (relayJwksUrl === undefined && sessionAuthorityUrl === undefined) return undefined
  return {
    ...(isNonEmptyString(relayJwksUrl) ? { relayJwksUrl } : {}),
    ...(isNonEmptyString(sessionAuthorityUrl) ? { sessionAuthorityUrl } : {}),
  }
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
    if (!isNonEmptyString(input.controlPlaneUrl)) return undefined
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
    const held = input.providerConfig === undefined ? undefined : hostConnectorProviderConfig(input.providerConfig)
    if (input.providerConfig !== undefined && !held) return undefined
    return {
      type: "bootstrap",
      requestId: id,
      heartbeatIntervalMs: input.heartbeatIntervalMs,
      controlPlaneUrl: input.controlPlaneUrl,
      ...(restored ? { identity: restored } : {}),
      ...(typeof input.displayName === "string" ? { displayName: input.displayName } : {}),
      ...(sessionAuthority ? { sessionAuthority } : {}),
      ...(shares ? { sharedWorkspaces: shares } : {}),
      ...(held ? { providerConfig: held } : {}),
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

  if (input.type === "identity-stored" || input.type === "sealing-key-stored" || input.type === "stop") {
    const id = requestId(input)
    return id ? { type: input.type, requestId: id } : undefined
  }

  if (input.type === "provider-config-stored") {
    const id = requestId(input)
    if (!id || typeof input.ok !== "boolean") return undefined
    if (input.ok) return { type: "provider-config-stored", requestId: id, ok: true }
    return typeof input.error === "string"
      ? { type: "provider-config-stored", requestId: id, ok: false, error: input.error }
      : undefined
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
    const endpoints = servingEndpoints(input.endpoints)
    if (input.endpoints !== undefined && !endpoints) return undefined
    const tunnel = input.tunnel === null ? null : asRecord(input.tunnel)
    if (tunnel === undefined) return undefined
    return { type: "serving", tunnel, ...(endpoints ? { endpoints } : {}) }
  }

  if (input.type === "identity-created") {
    const id = requestId(input)
    const created = identity(input.identity)
    return id && created ? { type: "identity-created", requestId: id, identity: created } : undefined
  }

  if (input.type === "sealing-key-created") {
    const id = requestId(input)
    return id && isJsonWebKey(input.sealingPrivateKeyJwk)
      ? { type: "sealing-key-created", requestId: id, sealingPrivateKeyJwk: input.sealingPrivateKeyJwk }
      : undefined
  }

  if (input.type === "provider-config") {
    const id = requestId(input)
    const config = hostConnectorProviderConfig(input)
    return id && config ? { type: "provider-config", requestId: id, ...config } : undefined
  }

  if (input.type === "provider-config-ready") {
    const rev = revision(input.revision)
    return rev !== undefined && typeof input.providers === "string"
      ? { type: "provider-config-ready", revision: rev, providers: input.providers }
      : undefined
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

  if (input.type === "child-error") {
    return isNonEmptyString(input.stage) && typeof input.detail === "string"
      ? { type: "child-error", stage: input.stage, detail: input.detail }
      : undefined
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
