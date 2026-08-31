export type OpenCodeServerAdapterErrorCode =
  | "invalid_config"
  | "invalid_directory"
  | "invalid_binding"
  | "immutable_connection_identity"
  | "transport_error"
  | "deadline_exceeded"
  | "http_error"
  | "compatibility_probe_failed"
  | "invalid_response"
  | "invalid_event"
  | "frame_too_large"
  | "reconciliation_gap"
  | "unsupported_interaction"
  | "unsupported_operation"
  | "disposed"

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
