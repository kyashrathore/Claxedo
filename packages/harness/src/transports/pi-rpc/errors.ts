export class PiTransportError extends Error {
  readonly retryable: boolean
  constructor(readonly code: "protocol" | "process" | "timeout" | "retirement" | "session" | "configuration", message: string, cause?: unknown) {
    super(message, { cause })
    this.name = "PiTransportError"
    this.retryable = code === "timeout" || code === "process"
  }
}
