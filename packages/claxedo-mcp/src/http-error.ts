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
  const code = string(nested?.code) ?? string(body?.code)
  const retryable = boolean(nested?.retryable) ?? boolean(body?.retryable)
  const message = (string(nested?.message)
    ?? string(body?.message)
    ?? string(body?.error)) || `HTTP ${status}`
  return new McpHttpError(status, code, message, retryable)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined
}

function string(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

function boolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined
}
