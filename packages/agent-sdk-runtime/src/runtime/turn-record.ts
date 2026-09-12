import type { PromptInput, SessionConfig } from "../index"
import { resolveSessionModel } from "../session-model"
import type { AgentRuntimeTurnStartInput } from "./contracts"

/**
 * The prompt one admitted turn runs: the turn's own choices, with the session's
 * stored config standing in wherever the caller named none.
 *
 * The author travels here as well as on the durable turn record, because a
 * harness stamps it onto the user message it builds itself and without it every
 * message a harness authors is attributed to nobody.
 */
export function turnPrompt(input: {
  turn: AgentRuntimeTurnStartInput
  config: SessionConfig
  userMessageId: string
  assistantMessageId: string
  handoff: string | undefined
}): PromptInput {
  const { turn, config, handoff } = input
  return {
    parts: turn.parts ?? (turn.text ? [{ type: "text", text: turn.text }] : []),
    userMessageId: input.userMessageId,
    assistantMessageId: input.assistantMessageId,
    agent: turn.agent ?? config.agent ?? "build",
    model: turn.model ?? resolveSessionModel(config),
    ...(turn.tools ? { tools: turn.tools } : {}),
    ...(turn.format ? { format: turn.format } : {}),
    ...(handoff || turn.system ? { system: [handoff, turn.system].filter(Boolean).join("\n\n") } : {}),
    ...(turn.permissionMode ? { permissionMode: turn.permissionMode } : {}),
    ...(turn.variant !== undefined ? { variant: turn.variant } : config.variant ? { variant: config.variant } : {}),
    ...(turn.author ? { author: turn.author } : {}),
  }
}

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
