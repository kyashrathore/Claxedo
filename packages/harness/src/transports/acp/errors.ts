export class AcpTransportError extends Error {
  readonly retryable: boolean

  constructor(readonly code: "connection" | "protocol" | "session" | "timeout" | "configuration" | "ownership", message: string, cause?: unknown) {
    super(message, { cause })
    this.name = "AcpTransportError"
    this.retryable = code === "connection" || code === "timeout"
  }
}
