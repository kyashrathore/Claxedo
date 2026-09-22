import { isFiniteNumber, isRecord } from "@claxedo/helpers/guards"

export const TUNNEL_PROTOCOL_VERSION = 1
export const SESSION_STREAM_LEASE_TTL_MS = 15_000
export const SESSION_TURN_LEASE_TTL_MS = 60_000

/**
 * Which generation of the sender-identity contract authorizes. 0 is every
 * binding row and every token written before the transports were proven to
 * carry the platform's stable account id, whose key may be a handle that now
 * belongs to somebody else. Authority stores write this number, the relay
 * admits only this number, and a lower one is never promoted.
 */
export const CURRENT_CHANNEL_IDENTITY_VERSION = 1

export {
  type TokenClaims,
  type TokenVerifierBaseClaims,
  type RuntimeAccessVerifierClaims,
  type RelayHostVerifierClaims,
  type TokenVerifier,
  type OidcTokenVerifierClaims,
  TokenVerifierError,
  type OidcTokenVerifierOptions,
  createOidcTokenVerifier,
  type HttpTokenVerifierOptions,
  createHttpTokenVerifier,
  type StaticTokenVerifierOptions,
  createStaticTokenVerifier,
} from "./token-verifier"

export type TunnelHeaderMap = Record<string, string>

export type TunnelPing = {
  type: "ping"
  protocol: typeof TUNNEL_PROTOCOL_VERSION
  id: string
  sent_at: number
}

export type TunnelPong = {
  type: "pong"
  protocol: typeof TUNNEL_PROTOCOL_VERSION
  id: string
  sent_at: number
  received_at: number
}

export type TunnelHostRegistrationUpdate = {
  type: "host.registration.update"
  protocol: typeof TUNNEL_PROTOCOL_VERSION
  workspace_ids: string[]
  token: string
}

export type TunnelHttpRequest = {
  type: "http.request"
  protocol: typeof TUNNEL_PROTOCOL_VERSION
  request_id: string
  workspace_id: string
  method: string
  path: string
  headers: TunnelHeaderMap
  body_base64?: string
  end: boolean
}

export type TunnelHttpResponseStart = {
  type: "http.response.start"
  protocol: typeof TUNNEL_PROTOCOL_VERSION
  request_id: string
  status: number
  headers: TunnelHeaderMap
}

export type TunnelHttpResponseChunk = {
  type: "http.response.chunk"
  protocol: typeof TUNNEL_PROTOCOL_VERSION
  request_id: string
  body_base64: string
}

export type TunnelHttpResponseEnd = {
  type: "http.response.end"
  protocol: typeof TUNNEL_PROTOCOL_VERSION
  request_id: string
}

export type TunnelHttpResponseFlow = {
  type: "http.response.flow"
  protocol: typeof TUNNEL_PROTOCOL_VERSION
  request_id: string
  paused: boolean
  reason?: "slow_consumer" | "drained" | "closed"
}

export type TunnelWsOpen = {
  type: "ws.open"
  protocol: typeof TUNNEL_PROTOCOL_VERSION
  channel_id: string
  workspace_id: string
  path: string
  headers: TunnelHeaderMap
}

export type TunnelWsFrame = {
  type: "ws.frame"
  protocol: typeof TUNNEL_PROTOCOL_VERSION
  channel_id: string
  data_base64: string
  binary: boolean
}

export type TunnelWsClose = {
  type: "ws.close"
  protocol: typeof TUNNEL_PROTOCOL_VERSION
  channel_id: string
  code?: number
  reason?: string
}

export type TunnelError = {
  type: "error"
  protocol: typeof TUNNEL_PROTOCOL_VERSION
  request_id?: string
  channel_id?: string
  code: string
  message: string
}

export type TunnelMessage =
  | TunnelPing
  | TunnelPong
  | TunnelHostRegistrationUpdate
  | TunnelHttpRequest
  | TunnelHttpResponseStart
  | TunnelHttpResponseChunk
  | TunnelHttpResponseEnd
  | TunnelHttpResponseFlow
  | TunnelWsOpen
  | TunnelWsFrame
  | TunnelWsClose
  | TunnelError

export type TunnelMessageValidation =
  | { ok: true; message: TunnelMessage }
  | {
    ok: false
    reason: "protocol_mismatch"
    expected_protocol: typeof TUNNEL_PROTOCOL_VERSION
    actual_protocol: unknown
    type?: string
  }
  | { ok: false; reason: "invalid" }

export function validateTunnelMessage(input: unknown): TunnelMessageValidation {
  if (!isRecord(input)) return { ok: false, reason: "invalid" }
  if (input.protocol !== TUNNEL_PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: "protocol_mismatch",
      expected_protocol: TUNNEL_PROTOCOL_VERSION,
      actual_protocol: input.protocol,
      ...(typeof input.type === "string" ? { type: input.type } : {}),
    }
  }
  if (!isTunnelMessageRecord(input)) return { ok: false, reason: "invalid" }
  return { ok: true, message: input }
}

export function isTunnelMessage(input: unknown): input is TunnelMessage {
  return isRecord(input) && isTunnelMessageRecord(input)
}

export function makeTunnelPong(input: TunnelPing, receivedAt = Date.now()): TunnelPong {
  return {
    type: "pong",
    protocol: TUNNEL_PROTOCOL_VERSION,
    id: input.id,
    sent_at: input.sent_at,
    received_at: receivedAt,
  }
}

export function makeTunnelPing(sentAt = Date.now(), id: string = crypto.randomUUID()): TunnelPing {
  return {
    type: "ping",
    protocol: TUNNEL_PROTOCOL_VERSION,
    id,
    sent_at: sentAt,
  }
}

/**
 * The single source of truth for what a wire frame must look like to be a `TunnelMessage`:
 * the switch's `default` arm is what rejects unknown `type` values, so no separate
 * list of valid types is kept anywhere.
 */
function isTunnelMessageRecord(row: Record<string, unknown>): row is TunnelMessage {
  if (row.protocol !== TUNNEL_PROTOCOL_VERSION) return false
  switch (row.type) {
    case "ping":
      return isNonEmptyString(row.id) && isFiniteNumber(row.sent_at)
    case "pong":
      return isNonEmptyString(row.id) && isFiniteNumber(row.sent_at) && isFiniteNumber(row.received_at)
    case "host.registration.update":
      return isStringArray(row.workspace_ids) && isNonEmptyString(row.token)
    case "http.request":
      return isNonEmptyString(row.request_id)
        && isNonEmptyString(row.workspace_id)
        && isNonEmptyString(row.method)
        && isNonEmptyString(row.path)
        && isTunnelHeaderMap(row.headers)
        && isOptionalBase64(row.body_base64)
        && typeof row.end === "boolean"
    case "http.response.start":
      return isNonEmptyString(row.request_id)
        && isHttpStatus(row.status)
        && isTunnelHeaderMap(row.headers)
    case "http.response.chunk":
      return isNonEmptyString(row.request_id) && isBase64(row.body_base64)
    case "http.response.end":
      return isNonEmptyString(row.request_id)
    case "http.response.flow":
      return isNonEmptyString(row.request_id)
        && typeof row.paused === "boolean"
        && (row.reason === undefined || row.reason === "slow_consumer" || row.reason === "drained" || row.reason === "closed")
    case "ws.open":
      return isNonEmptyString(row.channel_id)
        && isNonEmptyString(row.workspace_id)
        && isNonEmptyString(row.path)
        && isTunnelHeaderMap(row.headers)
    case "ws.frame":
      return isNonEmptyString(row.channel_id)
        && isBase64(row.data_base64)
        && typeof row.binary === "boolean"
    case "ws.close":
      return isNonEmptyString(row.channel_id)
        && (row.code === undefined || isCloseCode(row.code))
        && (row.reason === undefined || isNonEmptyString(row.reason))
    case "error":
      return (row.request_id === undefined || isNonEmptyString(row.request_id))
        && (row.channel_id === undefined || isNonEmptyString(row.channel_id))
        && isNonEmptyString(row.code)
        && isNonEmptyString(row.message)
    default:
      return false
  }
}

function isNonEmptyString(input: unknown) {
  return typeof input === "string" && input.length > 0
}

function isStringArray(input: unknown): input is string[] {
  return Array.isArray(input) && input.length > 0 && input.every(isNonEmptyString)
}

function isHttpStatus(input: unknown) {
  return typeof input === "number" && Number.isInteger(input) && input >= 100 && input <= 599
}

function isCloseCode(input: unknown) {
  // 1004, 1005, 1006 and 1015 are reserved and never legal on the wire.
  return typeof input === "number" && Number.isInteger(input)
    && input >= 1_000 && input <= 4_999
    && input !== 1_004 && input !== 1_005 && input !== 1_006 && input !== 1_015
}

// RFC 9110 field-name grammar. A name outside it throws in the Headers
// conversion every consumer performs, so it is rejected here instead.
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

function isTunnelHeaderMap(input: unknown): input is TunnelHeaderMap {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  for (const [name, value] of Object.entries(input)) {
    if (!HEADER_NAME.test(name) || typeof value !== "string") return false
  }
  return true
}

function isOptionalBase64(input: unknown) {
  return input === undefined || isBase64(input)
}

function isBase64(input: unknown) {
  return typeof input === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input)
}
