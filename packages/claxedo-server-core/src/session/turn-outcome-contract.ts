import { z } from "zod"
import { parseAgentTurnOutcome, type AgentTurnOutcome } from "@claxedo/agent-runtime-contract"

/** Preserve the runtime's complete terminal outcome, including its message identity. */
export const sessionTurnOutcomeSchema = z.custom<AgentTurnOutcome>((value) => {
  try { return parseAgentTurnOutcome(value) !== undefined } catch { return false }
})

export function storedSessionTurnOutcome(json: string | null | undefined) {
  return json == null ? undefined : sessionTurnOutcomeSchema.parse(JSON.parse(json))
}
