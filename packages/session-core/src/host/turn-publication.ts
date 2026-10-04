import type { AgentRuntimeEventEnvelope } from "./contracts"
import { isTerminalRuntimePayload } from "./turn-outcome"

/** Hold parent completion until cleanup releases admission; child events remain independent. */
export function createTurnPublication(
  sessionId: string,
  emit: (event: AgentRuntimeEventEnvelope) => void,
  releaseAdmission: () => void,
) {
  const terminal: AgentRuntimeEventEnvelope[] = []
  return {
    publish: (event: AgentRuntimeEventEnvelope) => {
      if (event.sessionId === sessionId && isTerminalRuntimePayload(event.payload)) terminal.push(event)
      else emit(event)
    },
    /**
     * Only a turn whose outcome the store accepted ends here. One that was
     * superseded, or whose outcome was not committed, keeps both its admission
     * and its held frames: releasing would admit the next turn over a session
     * the store still records as busy, and publishing an end the store never
     * accepted would show the caller a turn that did not finish.
     *
     * The release is generation-checked and idempotent, so it is safe whether
     * or not the finalizer has already performed it.
     */
    finish: (finalized: boolean) => {
      if (!finalized) return
      releaseAdmission()
      for (const event of terminal) emit(event)
    },
  }
}
