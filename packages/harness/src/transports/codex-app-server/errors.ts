import { asRecord } from "@claxedo/helpers/guards"
import type { ExitStatus } from "../../contract"
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

export class CodexRequestTimeout extends CodexTransportError {
  constructor(readonly method: string, ms: number) { super("process", `Codex ${method} did not answer within ${ms}ms`) }
}

function exitStatus(cause: unknown): ExitStatus | undefined {
  const row = asRecord(cause)
  if (!row || !("code" in row)) return undefined
  return { code: typeof row.code === "number" ? row.code : null, signal: typeof row.signal === "string" ? row.signal : null }
}

export function codexChannelError(reason: "frame" | "stdout" | "exit" | "write", cause: unknown, stderr: string): CodexTransportError {
  if (reason === "frame") return new CodexTransportError("protocol", "Invalid Codex JSON-RPC frame", { cause })
  const exit = reason === "exit" ? exitStatus(cause) : undefined
  const ended = exit ? `Codex app-server exited with ${exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`}` : `Codex ${reason} failed`
  return new CodexTransportError("process", stderr ? `${ended}: ${stderr}` : ended, { cause })
}

export function codexRpcError(error: { code: number; message: string }): CodexTransportError {
  if (/^no active turn to interrupt$/i.test(error.message)) return new CodexNoActiveTurnError()
  return new CodexTransportError("protocol", error.message)
}
