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
 * Headers and body of one beat or acquire; a beat that outlives this is
 * abandoned and the lease it was renewing is left to the next one.
 */
export const MACHINE_REQUEST_TIMEOUT_MS = 15_000
/** Redeem writes the enrollment; a longer bound, and the bootstrap retry re-redeems the same key. */
export const REDEEM_REQUEST_TIMEOUT_MS = 30_000

/** A request the control plane did not answer within its bound; a transport failure, never a decision. */
export class HostedRequestTimeoutError extends Error {
  readonly pathname: string
  readonly timeoutMs: number
  constructor(pathname: string, timeoutMs: number, cause?: unknown) {
    super(`control plane did not answer POST ${pathname} within ${timeoutMs / 1000}s`, cause === undefined ? undefined : { cause })
    this.name = "HostedRequestTimeoutError"
    this.pathname = pathname
    this.timeoutMs = timeoutMs
  }
}

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
    if (!isPlainRecord(body) || !isPlainRecord(body.error)) return undefined
    return typeof body.error.code === "string" ? body.error.code : undefined
  } catch {
    return undefined
  }
}

export function controlPlaneRequestUrl(controlPlaneUrl: string, pathname: string) {
  return new URL(controlPlaneUrl.replace(/\/+$/, "") + pathname)
}

/**
 * Send JSON and parse JSON within `timeoutMs`; a non-2xx answer becomes a
 * `HostedHttpError`, a request still open at the deadline a
 * `HostedRequestTimeoutError`. The body is read once as text so a non-JSON
 * error page is still reported with its status rather than as a parse
 * failure that hides it.
 *
 * The deadline is raced here as well as handed to `fetch` as its signal: the
 * signal is what closes the socket, the race is what returns even through a
 * `fetch` that ignores it (the response body's reader included).
 */
export async function postJson(
  fetchImpl: FetchLike,
  url: URL,
  bodyText: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<unknown> {
  const signal = AbortSignal.timeout(timeoutMs)
  const timedOut = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(new HostedRequestTimeoutError(url.pathname, timeoutMs, signal.reason)), { once: true })
  })
  let text: string
  let response: Response
  try {
    ;({ response, text } = await Promise.race([
      (async () => {
        const answer = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: bodyText,
          signal,
        })
        return { response: answer, text: await answer.text() }
      })(),
      timedOut,
    ]))
  } catch (error) {
    if (signal.aborted && !(error instanceof HostedRequestTimeoutError)) {
      throw new HostedRequestTimeoutError(url.pathname, timeoutMs, error)
    }
    throw error
  }
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
  if (!Array.isArray(roots)) return undefined
  const allowed = roots.filter((root): root is string => typeof root === "string")
  if (allowed.length !== roots.length) return undefined
  const visibility = value.visibility === "org" ? "org" : "owner"
  return { revision: requireNumber(value.revision, "scope.revision"), allowed_roots: allowed, visibility }
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
  requestTimeoutMs?: number
}

export function createMachineSignedTransport(options: MachineSignedTransportOptions): MachineTransport {
  const now = options.now ?? (() => Date.now())
  const nonce = options.nonce ?? randomNonce
  const timeoutMs = options.requestTimeoutMs ?? MACHINE_REQUEST_TIMEOUT_MS

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
    }, timeoutMs)
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
