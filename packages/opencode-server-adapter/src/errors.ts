export type OpenCodeServerAdapterErrorCode = "invalid_config"

export class OpenCodeServerAdapterError extends Error {
  constructor(
    readonly code: OpenCodeServerAdapterErrorCode,
    message: string,
    readonly details: { operation?: string; status?: number; body?: unknown } = {},
  ) {
    super(message)
    this.name = "OpenCodeServerAdapterError"
  }

  get operation() { return this.details.operation }
  get status() { return this.details.status }
  get body() { return this.details.body }
}
