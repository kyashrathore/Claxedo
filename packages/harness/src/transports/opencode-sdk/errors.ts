export class OpenCodeTransportError extends Error {
  readonly retryable: boolean
  constructor(readonly className: "owner" | "session" | "configuration" | "request" | "engine", message: string,
    options?: { cause?: unknown; retryable?: boolean }) {
    super(message, { cause: options?.cause })
    this.name = "OpenCodeTransportError"
    this.retryable = options?.retryable ?? className === "engine"
  }
}

export class OpenCodeOwnerMismatchError extends OpenCodeTransportError {
  constructor() {
    super("owner", "OpenCode engine credentials belong to another session owner")
    this.name = "OpenCodeOwnerMismatchError"
  }
}
