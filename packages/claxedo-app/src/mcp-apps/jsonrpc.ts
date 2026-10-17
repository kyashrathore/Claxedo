import { asRecord, isNonEmptyString } from "@claxedo/helpers/guards"

export type JsonRpcId = string | number

export type JsonRpcParams = Readonly<Record<string, unknown>>

export type JsonRpcError = { readonly code: number; readonly message: string }

export type InboundMessage =
  | { readonly kind: "request"; readonly id: JsonRpcId; readonly method: string; readonly params: JsonRpcParams }
  | { readonly kind: "notification"; readonly method: string; readonly params: JsonRpcParams }
  | { readonly kind: "response"; readonly id: JsonRpcId }

export type OutboundMessage =
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly result: JsonRpcParams }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly error: JsonRpcError }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly method: string; readonly params: JsonRpcParams }
  | { readonly jsonrpc: "2.0"; readonly method: string; readonly params: JsonRpcParams }

export const RPC_INVALID_REQUEST = -32600
export const RPC_METHOD_NOT_FOUND = -32601
export const RPC_INVALID_PARAMS = -32602
export const RPC_INTERNAL_ERROR = -32603
export const RPC_REFUSED = -32000

export type RequestAnswer = { readonly kind: "result"; readonly result: JsonRpcParams } | { readonly kind: "error"; readonly error: JsonRpcError }

export function rpcResult(result: JsonRpcParams = {}): RequestAnswer {
  return { kind: "result", result }
}

export function rpcError(message: string, code = RPC_REFUSED): RequestAnswer {
  return { kind: "error", error: { code, message } }
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
}

export function messageBytes(data: unknown): number | undefined {
  try {
    const text = JSON.stringify(data)
    return text === undefined ? undefined : new TextEncoder().encode(text).length
  } catch (error) {
    console.warn("mcp-apps: a frame message could not be measured", { error })
    return undefined
  }
}

export function inboundMessage(data: unknown): InboundMessage | undefined {
  const message = asRecord(data)
  if (!message || message.jsonrpc !== "2.0") return undefined
  const params = asRecord(message.params) ?? {}
  if (isNonEmptyString(message.method)) {
    return isId(message.id) ? { kind: "request", id: message.id, method: message.method, params } : { kind: "notification", method: message.method, params }
  }
  if (isId(message.id) && ("result" in message || "error" in message)) return { kind: "response", id: message.id }
  return undefined
}

export function rpcRequestId(data: unknown): JsonRpcId | undefined {
  const id = asRecord(data)?.id
  return isId(id) ? id : undefined
}

export function responseMessage(id: JsonRpcId, answer: RequestAnswer): OutboundMessage {
  return answer.kind === "result" ? { jsonrpc: "2.0", id, result: answer.result } : { jsonrpc: "2.0", id, error: answer.error }
}
