import { TransportError } from "../../contract/errors"

export class AcpTransportError extends TransportError {
  constructor(readonly code: "connection" | "protocol" | "session" | "timeout" | "configuration" | "ownership", message: string, cause?: unknown,
    detail?: Readonly<Record<string, string>>) {
    super("acp", code, message, { cause, ...(detail ? { detail } : {}) })
  }
}

export function acpAuthenticationRequired(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  if ("code" in error && error.code === -32000) return true
  return "cause" in error && error.cause !== error && acpAuthenticationRequired(error.cause)
}
