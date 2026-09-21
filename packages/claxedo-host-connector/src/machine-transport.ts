/**
 * A `claxedo connect` host talks to the control plane with its key alone:
 * every request carries the four machine headers and is signed over method,
 * path, body hash, timestamp, nonce and enrollment id. No bearer
 * exists on the box, so nothing here can be re-used by an account caller.
 */

import {
  MACHINE_REQUEST_HEADERS,
  machineRequestSignature,
  randomNonce,
  type HostKeyPair,
} from "./host-identity"
import { canonicalControlPlaneUrl, isPlainRecord, type HostScope } from "./host-state"
import type { AssignmentDescription, HeartbeatResponse, MachineHeartbeatInput, MachineTransport, ProviderConfigRevision } from "./connector"

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

/**
 * A control plane that answered a machine POST with a location instead of an
 * answer. Never followed: the body carries the invitation secret or a
 * signature over THIS path, and a followed redirect would re-send both to
 * wherever the 3xx pointed.
 */
export class HostedRedirectError extends Error {
  readonly pathname: string
  readonly status: number
  constructor(pathname: string, status: number) {
    super(`control plane answered POST ${pathname} with a redirect (${status || "opaque"}); a machine request is never re-sent elsewhere`)
    this.name = "HostedRedirectError"
    this.pathname = pathname
    this.status = status
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

/**
 * The one composition of a machine request's URL, canonical base first: no
 * caller reaches the wire with a base that has not been through
 * `canonicalControlPlaneUrl`, so the path this returns is the path the
 * signature covers.
 */
export function controlPlaneRequestUrl(controlPlaneUrl: string, pathname: string) {
  return new URL(canonicalControlPlaneUrl(controlPlaneUrl) + pathname)
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
 *
 * Redirects are refused twice over, for the same reason: `redirect: "manual"`
 * stops a conforming `fetch` from re-sending the body, and the answer is
 * denied afterwards so a `fetch` that ignored the option — and already
 * followed — cannot pass an attacker's response off as the control plane's.
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
          redirect: "manual",
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
  if (response.redirected || response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    throw new HostedRedirectError(url.pathname, response.status)
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

/**
 * `{revision, sealed}` or nothing. A revision with no readable `sealed`
 * member is refused rather than read as a withdrawal: a truncated blob would
 * otherwise revoke this machine's credentials and be acked for it.
 */
export function decodeProviderConfig(value: unknown): ProviderConfigRevision | undefined {
  if (!isPlainRecord(value)) return undefined
  const sealed = value.sealed
  if (sealed !== null && (typeof sealed !== "string" || !sealed)) {
    throw new Error("control plane returned a malformed provider configuration")
  }
  return { revision: requireNumber(value.revision, "providerConfig.revision"), sealed }
}

export function decodeHeartbeatResponse(value: unknown): HeartbeatResponse {
  if (!isPlainRecord(value)) throw new Error("control plane returned no heartbeat body")
  const assigned = Array.isArray(value.assigned_workspace_ids)
    ? value.assigned_workspace_ids.filter((id): id is string => typeof id === "string")
    : undefined
  const assignments = decodeAssignments(value.assignments)
  const scope = decodeScope(value.scope)
  const providerConfig = decodeProviderConfig(value.provider_config)
  return {
    expires_at: requireNumber(value.expires_at, "expires_at"),
    ...(assigned ? { assigned_workspace_ids: assigned } : {}),
    ...(isPlainRecord(value.hostTunnel) ? { hostTunnel: value.hostTunnel } : {}),
    ...(assignments ? { assignments } : {}),
    ...(scope ? { scope } : {}),
    ...(providerConfig ? { providerConfig } : {}),
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
   *
   * Omitted by a caller whose enrollment answer never stated one: the account
   * enroll route returns the enrollment, not the version its key landed at.
   * The verifier compares the field only when it is present, and a key that
   * was replaced still fails — as `machine_request_denied`, because the stored
   * public key no longer verifies this signature.
   */
  keyVersion?: number
  fetch: FetchLike
  now?: () => number
  nonce?: () => string
  requestTimeoutMs?: number
}

export function createMachineSignedTransport(options: MachineSignedTransportOptions): MachineTransport {
  // Refused here rather than on the first beat: a transport that exists is one
  // whose every request has an endpoint it is allowed to reach.
  const controlPlaneUrl = canonicalControlPlaneUrl(options.controlPlaneUrl)
  const now = options.now ?? (() => Date.now())
  const nonce = options.nonce ?? randomNonce
  const timeoutMs = options.requestTimeoutMs ?? MACHINE_REQUEST_TIMEOUT_MS

  const keyVersion = options.keyVersion === undefined ? {} : { keyVersion: options.keyVersion }

  const signedPost = async (pathname: string, body: Record<string, unknown>, requestTimeoutMs = timeoutMs) => {
    const url = controlPlaneRequestUrl(controlPlaneUrl, pathname)
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
    }, requestTimeoutMs)
  }

  return {
    acquire: async (input) => {
      const value = await signedPost(
        HOST_ENROLLMENT_ACQUIRE_PATH,
        keyVersion,
        input?.timeoutMs === undefined ? timeoutMs : Math.min(timeoutMs, input.timeoutMs),
      )
      if (!isPlainRecord(value)) throw new Error("control plane returned no acquire body")
      return { generation: requireNumber(value.generation, "generation") }
    },
    heartbeat: async (input: MachineHeartbeatInput) => {
      const value = await signedPost(HOST_ENROLLMENT_HEARTBEAT_PATH, {
        ...keyVersion,
        generation: input.generation,
        acks: input.acks.map((ack) => ({ workspaceId: ack.workspaceId, revision: ack.revision })),
        ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
        ...(input.sessionAuthority ? { sessionAuthority: input.sessionAuthority } : {}),
        ...(input.sealingPublicKey ? { sealingPublicKey: input.sealingPublicKey } : {}),
        ...(input.providerConfigRevision === undefined ? {} : { providerConfigRevision: input.providerConfigRevision }),
      })
      return decodeHeartbeatResponse(value)
    },
  }
}
