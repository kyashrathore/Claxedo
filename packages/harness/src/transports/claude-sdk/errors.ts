export class ClaudeTransportError extends Error {
  constructor(readonly kind: "configuration" | "process" | "protocol" | "session", message: string, readonly retryable = false, options?: ErrorOptions) {
    super(message, options)
    this.name = "ClaudeTransportError"
  }
}
