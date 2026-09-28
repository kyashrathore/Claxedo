import { TransportError } from "../../contract/errors"

export class CodexTransportError extends TransportError {
  constructor(readonly className: "process" | "protocol" | "session" | "configuration", message: string, options?: { cause?: unknown; retryable?: boolean }) {
    super("codex", className, message, options)
  }
}

export class CodexRequestRefusal extends CodexTransportError {
  constructor(readonly rpcCode: number, message: string) {
    super("protocol", message)
  }
}

export class CodexNoActiveTurnError extends CodexTransportError {
  constructor() { super("protocol", "No active turn to interrupt") }
}

export class CodexDeadlineError extends CodexTransportError {
  constructor(message: string) { super("process", message) }
}

export function codexRpcError(error: { code: number; message: string }): CodexTransportError {
  if (/^no active turn to interrupt$/i.test(error.message)) return new CodexNoActiveTurnError()
  return new CodexTransportError("protocol", error.message)
}

export function isMissingCodexThread(error: unknown): boolean {
  return error instanceof CodexTransportError && /thread not found/i.test(error.message)
}
