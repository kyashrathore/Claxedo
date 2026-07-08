export const TUNNEL_PROTOCOL_VERSION = 1

export {
  type TokenClaims,
  type TokenVerifierBaseClaims,
  type RuntimeAccessVerifierClaims,
  type RelayHostVerifierClaims,
  type TokenVerifier,
  type ClerkTokenVerifierClaims,
  TokenVerifierError,
  type ClerkTokenVerifierOptions,
  createClerkTokenVerifier,
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
  | TunnelHttpRequest
  | TunnelHttpResponseStart
  | TunnelHttpResponseChunk
  | TunnelHttpResponseEnd
  | TunnelHttpResponseFlow
  | TunnelWsOpen
  | TunnelWsFrame
  | TunnelWsClose
  | TunnelError

const tunnelMessageTypes = new Set<TunnelMessage["type"]>([
  "ping",
  "pong",
  "http.request",
  "http.response.start",
  "http.response.chunk",
  "http.response.end",
  "http.response.flow",
  "ws.open",
  "ws.frame",
  "ws.close",
  "error",
])

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
  if (!input || typeof input !== "object") return { ok: false, reason: "invalid" }
  const row = input as Record<string, unknown>
  if (row.protocol !== TUNNEL_PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: "protocol_mismatch",
      expected_protocol: TUNNEL_PROTOCOL_VERSION,
      actual_protocol: row.protocol,
      ...(typeof row.type === "string" ? { type: row.type } : {}),
    }
  }
  if (typeof row.type !== "string") return { ok: false, reason: "invalid" }
  if (!tunnelMessageTypes.has(row.type as TunnelMessage["type"])) return { ok: false, reason: "invalid" }
  if (!validateTunnelMessageShape(row)) return { ok: false, reason: "invalid" }
  return { ok: true, message: row as TunnelMessage }
}

export function isTunnelMessage(input: unknown): input is TunnelMessage {
  return validateTunnelMessage(input).ok
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

function validateTunnelMessageShape(row: Record<string, unknown>) {
  switch (row.type) {
    case "ping":
      return isString(row.id) && isFiniteNumber(row.sent_at)
    case "pong":
      return isString(row.id) && isFiniteNumber(row.sent_at) && isFiniteNumber(row.received_at)
    case "http.request":
      return isString(row.request_id)
        && isString(row.workspace_id)
        && isString(row.method)
        && isString(row.path)
        && isTunnelHeaderMap(row.headers)
        && isOptionalBase64(row.body_base64)
        && typeof row.end === "boolean"
    case "http.response.start":
      return isString(row.request_id)
        && isHttpStatus(row.status)
        && isTunnelHeaderMap(row.headers)
    case "http.response.chunk":
      return isString(row.request_id) && isBase64(row.body_base64)
    case "http.response.end":
      return isString(row.request_id)
    case "http.response.flow":
      return isString(row.request_id)
        && typeof row.paused === "boolean"
        && (row.reason === undefined || row.reason === "slow_consumer" || row.reason === "drained" || row.reason === "closed")
    case "ws.open":
      return isString(row.channel_id)
        && isString(row.workspace_id)
        && isString(row.path)
        && isTunnelHeaderMap(row.headers)
    case "ws.frame":
      return isString(row.channel_id)
        && isBase64(row.data_base64)
        && typeof row.binary === "boolean"
    case "ws.close":
      return isString(row.channel_id)
        && (row.code === undefined || isCloseCode(row.code))
        && (row.reason === undefined || isString(row.reason))
    case "error":
      return (row.request_id === undefined || isString(row.request_id))
        && (row.channel_id === undefined || isString(row.channel_id))
        && isString(row.code)
        && isString(row.message)
    default:
      return false
  }
}

function isString(input: unknown) {
  return typeof input === "string" && input.length > 0
}

function isFiniteNumber(input: unknown) {
  return typeof input === "number" && Number.isFinite(input)
}

function isHttpStatus(input: unknown) {
  return typeof input === "number" && Number.isInteger(input) && input >= 100 && input <= 599
}

function isCloseCode(input: unknown) {
  return typeof input === "number" && Number.isInteger(input) && input >= 0 && input <= 65_535
}

function isTunnelHeaderMap(input: unknown): input is TunnelHeaderMap {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  for (const value of Object.values(input)) {
    if (typeof value !== "string") return false
  }
  return true
}

function isOptionalBase64(input: unknown) {
  return input === undefined || isBase64(input)
}

function isBase64(input: unknown) {
  return typeof input === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input)
}
