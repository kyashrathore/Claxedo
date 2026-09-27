import { asRecord } from "@claxedo/agent-runtime-contract"
import { errorMessage } from "@claxedo/helpers"
import { AcpTransportError } from "./errors"

const RESUME = "Resume the existing session to inspect its state."

export type AcpTurnFailureFacts = { submitted: boolean; connectionAlive: boolean; uncertain: boolean }

export function acpTurnFailure(error: unknown, facts: AcpTurnFailureFacts): AcpTransportError {
  if (error instanceof AcpTransportError && error.detail) return error
  const rejectedByAgent = typeof asRecord(error)?.code === "number"
  const lostAfterSubmit = facts.submitted && !facts.connectionAlive && !rejectedByAgent
  const message = errorMessage(error)
  if (facts.uncertain || lostAfterSubmit) {
    return new AcpTransportError("session", facts.uncertain ? message : `${message}. Execution outcome is uncertain; no prompt was retried. ${RESUME}`,
      error, { acpOutcome: "uncertain", recovery: `${RESUME} The failed prompt was not retried.` })
  }
  return new AcpTransportError(error instanceof AcpTransportError ? error.code : "session", message, error,
    { acpOutcome: facts.submitted ? "rejected" : "not_started" })
}
