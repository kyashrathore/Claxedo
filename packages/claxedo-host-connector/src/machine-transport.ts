/**
 * A `claxedo connect` host talks to the control plane with its key alone:
 * every request carries the four machine headers and is signed over method,
 * path, body hash, timestamp, nonce and enrollment id (P1.1). No bearer
 * exists on the box, so nothing here can be re-used by an account caller.
 */

import {
  MACHINE_REQUEST_HEADERS,
  machineRequestSignature,
  randomNonce,
  type HostKeyPair,
} from "./host-identity"
import { isPlainRecord, type HostScope } from "./host-state"
import type { AssignmentDescription, HeartbeatResponse, MachineHeartbeatInput, MachineTransport } from "./connector"

/** What this package needs of `fetch`; the global one satisfies it under Node, Bun and Electron. */
export type FetchLike = (input: URL, init: RequestInit) => Promise<Response>

export const HOST_ENROLLMENT_ACQUIRE_PATH = "/api/claxedo/host/enrollments/acquire"
export const HOST_ENROLLMENT_HEARTBEAT_PATH = "/api/claxedo/host/enrollments/heartbeat"
export const HOST_ENROLLMENT_REDEEM_PATH = "/api/claxedo/host/enrollments/redeem"

/**
 * An HTTP refusal, in the one message shape every reader of this package
 * already parses: `transientHeartbeatFailure` reads the status, `decisionCode`
 * the control plane's error code.
 */
export class HostedHttpError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, body: unknown) {
    super(`HOSTED_HTTP ${status} ${JSON.stringify(body)}`)
    this.name = "HostedHttpError"
    this.status = status
    this.body = body
  }
}

/** The `error.code` of a `HOSTED_HTTP <status> <json>` failure, if it carries one. */
export function decisionCode(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error)
  const match = /^HOSTED_HTTP \d{3} (.*)$/s.exec(message)
  if (!match) return undefined
  try {
    const body: unknown = JSON.parse(match[1] ?? "")
    const code = (body as { error?: { code?: unknown } })?.error?.code
    return typeof code === "string" ? code : undefined
  } catch {
    return undefined
  }
}

export function controlPlaneRequestUrl(controlPlaneUrl: string, pathname: string) {
  return new URL(controlPlaneUrl.replace(/\/+$/, "") + pathname)
}

/**
 * Send JSON and parse JSON; a non-2xx answer becomes a `HostedHttpError`. The
 * body is read once as text so a non-JSON error page is still reported with
 * its status rather than as a parse failure that hides it.
 */
export async function postJson(
  fetchImpl: FetchLike,
  url: URL,
  bodyText: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: bodyText,
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = { error: { code: "invalid_response", message: text.slice(0, 200) } }
  }
  if (!response.ok) throw new HostedHttpError(response.status, parsed)
  return parsed
}

export function requireNumber(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`control plane returned no ${field}`)
  return value
}

export function requireString(value: unknown, field: string) {
  if (typeof value !== "string" || !value) throw new Error(`control plane returned no ${field}`)
  return value
}

export function decodeScope(value: unknown): HostScope | undefined {
  if (!isPlainRecord(value)) return undefined
  const roots = value.allowed_roots
  if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string")) return undefined
  const visibility = value.visibility === "org" ? "org" : "owner"
  return { revision: requireNumber(value.revision, "scope.revision"), allowed_roots: roots as string[], visibility }
}

export function decodeEndpoints(value: Record<string, unknown>) {
  const relay = isPlainRecord(value.relay) ? value.relay : undefined
  const authority = isPlainRecord(value.authority) ? value.authority : undefined
  return {
    ...(relay && typeof relay.url === "string" && typeof relay.jwks_url === "string"
      ? { relay: { url: relay.url, jwksUrl: relay.jwks_url } }
      : {}),
    ...(authority && typeof authority.session_authority_url === "string"
      ? { authority: { sessionAuthorityUrl: authority.session_authority_url } }
      : {}),
  }
}

function decodeAssignments(value: unknown): AssignmentDescription[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map((entry, index) => {
    if (!isPlainRecord(entry)) throw new Error(`control plane returned a malformed assignment at ${index}`)
    return {
      workspaceId: requireString(entry.workspace_id, "assignment.workspace_id"),
      remoteDirectory: requireString(entry.remote_directory, "assignment.remote_directory"),
      ...(typeof entry.display_name === "string" ? { displayName: entry.display_name } : {}),
      revision: requireNumber(entry.revision, "assignment.revision"),
    }
  })
}

export function decodeHeartbeatResponse(value: unknown): HeartbeatResponse {
  if (!isPlainRecord(value)) throw new Error("control plane returned no heartbeat body")
  const assigned = Array.isArray(value.assigned_workspace_ids)
    ? value.assigned_workspace_ids.filter((id): id is string => typeof id === "string")
    : undefined
  const assignments = decodeAssignments(value.assignments)
  const scope = decodeScope(value.scope)
  return {
    expires_at: requireNumber(value.expires_at, "expires_at"),
    ...(assigned ? { assigned_workspace_ids: assigned } : {}),
    ...(isPlainRecord(value.hostTunnel) ? { hostTunnel: value.hostTunnel } : {}),
    ...(assignments ? { assignments } : {}),
    ...(scope ? { scope } : {}),
    ...decodeEndpoints(value),
  }
}

export type MachineSignedTransportOptions = {
  controlPlaneUrl: string
  keys: HostKeyPair
  enrollmentId: string
  hostId: string
  /**
   * Sent in the body so a key the control plane has since replaced fails as
   * `enrollment_key_version_mismatch` (a decision) instead of as a generic
   * signature refusal.
   */
  keyVersion: number
  fetch: FetchLike
  now?: () => number
  nonce?: () => string
}

export function createMachineSignedTransport(options: MachineSignedTransportOptions): MachineTransport {
  const now = options.now ?? (() => Date.now())
  const nonce = options.nonce ?? randomNonce

  const signedPost = async (pathname: string, body: Record<string, unknown>) => {
    const url = controlPlaneRequestUrl(options.controlPlaneUrl, pathname)
    const bodyText = JSON.stringify({ enrollmentId: options.enrollmentId, hostId: options.hostId, ...body })
    // Fresh per request, never reused: the nonce is single-use at the
    // control plane and the timestamp is checked against its clock.
    const ts = Math.floor(now())
    const requestNonce = nonce()
    const signature = await machineRequestSignature(options.keys, {
      method: "POST",
      pathname: url.pathname,
      bodyText,
      ts,
      nonce: requestNonce,
      enrollmentId: options.enrollmentId,
    })
    return await postJson(options.fetch, url, bodyText, {
      [MACHINE_REQUEST_HEADERS.enrollmentId]: options.enrollmentId,
      [MACHINE_REQUEST_HEADERS.ts]: String(ts),
      [MACHINE_REQUEST_HEADERS.nonce]: requestNonce,
      [MACHINE_REQUEST_HEADERS.signature]: signature,
    })
  }

  return {
    createRequest: async () => {
      throw new Error("a machine-signed transport is already enrolled; it never requests an enrollment nonce")
    },
    enroll: async () => {
      throw new Error("a machine-signed transport is already enrolled; enrollment is by invitation")
    },
    acquire: async () => {
      const value = await signedPost(HOST_ENROLLMENT_ACQUIRE_PATH, { keyVersion: options.keyVersion })
      if (!isPlainRecord(value)) throw new Error("control plane returned no acquire body")
      return { generation: requireNumber(value.generation, "generation") }
    },
    heartbeat: async (input: MachineHeartbeatInput) => {
      const value = await signedPost(HOST_ENROLLMENT_HEARTBEAT_PATH, {
        keyVersion: options.keyVersion,
        generation: input.generation,
        acks: input.acks.map((ack) => ({ workspaceId: ack.workspaceId, revision: ack.revision })),
        ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
        ...(input.sessionAuthority ? { sessionAuthority: input.sessionAuthority } : {}),
      })
      return decodeHeartbeatResponse(value)
    },
  }
}
