export class CodexTransportError extends Error {
  readonly retryable: boolean
  constructor(readonly className: "process" | "protocol" | "session" | "configuration", message: string, options?: { cause?: unknown; retryable?: boolean }) {
    super(message, { cause: options?.cause })
    this.name = "CodexTransportError"
    this.retryable = options?.retryable ?? className === "process"
  }
}

export function isMissingCodexThread(error: unknown): boolean {
  return error instanceof CodexTransportError && /thread not found/i.test(error.message)
}
