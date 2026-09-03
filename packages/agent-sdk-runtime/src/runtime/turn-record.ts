import type { PromptInput } from "../index"
import type { AgentRuntimeTurnStartInput } from "./contracts"

/**
 * The durable record for one admitted turn: actor identity and the host's
 * admission fencing token travel with the prompt so the store can reject a
 * write from a turn whose admission a later takeover has already superseded.
 */
export function turnStartRecord(
  turn: AgentRuntimeTurnStartInput,
  prompt: PromptInput,
  userMessageId: string,
  assistantMessageId: string,
  agentSessionId: string | undefined,
) {
  return {
    sessionId: turn.sessionId,
    ...(agentSessionId ? { agentSessionId } : {}),
    userMessageId,
    assistantMessageId,
    agent: prompt.agent,
    model: prompt.model,
    parts: prompt.parts,
    ...(turn.tools ? { tools: turn.tools } : {}),
    ...(turn.format ? { format: turn.format } : {}),
    ...(turn.system ? { system: turn.system } : {}),
    ...(prompt.variant ? { variant: prompt.variant } : {}),
    ...(turn.actorId && turn.actorKind ? { actorId: turn.actorId, actorKind: turn.actorKind } : {}),
    ...(turn.author ? { author: turn.author } : {}),
    ...(turn.admission ? { fencingToken: turn.admission.fencingToken() } : {}),
  }
}
