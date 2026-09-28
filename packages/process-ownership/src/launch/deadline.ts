import type { RecoveryErrorCode } from "@claxedo/agent-runtime-contract"

export class RecoveryCodedError extends Error {
  constructor(readonly code: RecoveryErrorCode, message: string) {
    super(message)
    this.name = "RecoveryCodedError"
  }
}

export function deadlineExceeded(what: string) {
  return new RecoveryCodedError("deadline_exceeded", `${what} did not answer within its deadline; its outcome is unknown`)
}
