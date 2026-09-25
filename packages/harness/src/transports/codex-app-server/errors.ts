export class CodexTransportError extends Error {
  readonly retryable: boolean
  constructor(readonly className: "process" | "protocol" | "session" | "configuration", message: string, options?: { cause?: unknown; retryable?: boolean }) {
    super(message, { cause: options?.cause })
    this.name = "CodexTransportError"
    this.retryable = options?.retryable ?? className === "process"
  }
}

export class CodexRequestRefusal extends CodexTransportError {
  constructor(readonly code: number, message: string) {
    super("protocol", message)
  }
}

export class CodexNoActiveTurnError extends CodexTransportError {
  constructor() { super("protocol", "No active turn to interrupt") }
}

export function codexRpcError(error: { code: number; message: string }): CodexTransportError {
  if (/^no active turn to interrupt$/i.test(error.message)) return new CodexNoActiveTurnError()
  return new CodexTransportError("protocol", error.message)
}

export function isMissingCodexThread(error: unknown): boolean {
  return error instanceof CodexTransportError && /thread not found/i.test(error.message)
}
