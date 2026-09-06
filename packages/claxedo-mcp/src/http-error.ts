import { bool, record, text } from "./json"

export class McpHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly retryable?: boolean,
  ) {
    super(message)
    this.name = "McpHttpError"
  }
}

export function mcpHttpError(status: number, value: unknown) {
  const body = record(value)
  const nested = record(body?.error)
  const code = text(nested?.code) ?? text(body?.code)
  const retryable = bool(nested?.retryable) ?? bool(body?.retryable)
  const message = (text(nested?.message)
    ?? text(body?.message)
    ?? text(body?.error)) || `HTTP ${status}`
  return new McpHttpError(status, code, message, retryable)
}
