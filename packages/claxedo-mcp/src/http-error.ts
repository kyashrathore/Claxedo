import { decodeApiError } from "@claxedo/helpers/api-error"

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
  const error = decodeApiError(status, value)
  return new McpHttpError(status, error?.code, error?.message || `HTTP ${status}`, error?.retryable ?? false)
}
