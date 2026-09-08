import type { AgentRuntimeEventEnvelope } from "./contracts"
import { isTerminalRuntimePayload } from "./turn-outcome"

/** Hold parent completion until cleanup releases admission; child events remain independent. */
export function createTurnPublication(
  sessionId: string,
  emit: (event: AgentRuntimeEventEnvelope) => void,
  admitted: () => boolean,
  releaseAdmission: () => void,
) {
  const terminal: AgentRuntimeEventEnvelope[] = []
  return {
    publish(event: AgentRuntimeEventEnvelope) {
      if (event.sessionId === sessionId && isTerminalRuntimePayload(event.payload)) terminal.push(event)
      else emit(event)
    },
    finish() {
      if (!admitted()) return
      releaseAdmission()
      for (const event of terminal) emit(event)
    },
  }
}
