export class CursorTransportError extends Error {
  readonly retryable: boolean
  constructor(readonly code: "configuration" | "worker" | "session" | "sdk", message: string, cause?: unknown) {
    super(message, { cause })
    this.name = "CursorTransportError"
    this.retryable = code === "worker" || code === "sdk"
  }
}
