import type { AgentTodo, PromptInput } from "@claxedo/agent-runtime-contract"
import type { TurnInput, TurnOrigin } from "@claxedo/harness/contract"

/**
 * The turn as a transport receives it: the resolved model, effort and system
 * block beside the prompt parts, never a second copy inside the prompt.
 */
export function turnInputFor(prompt: PromptInput, todos: readonly AgentTodo[], origin: TurnOrigin): TurnInput {
  const { model, variant, system, ...rest } = prompt
  if (!prompt.assistantMessageId || !prompt.userMessageId) throw new Error("A turn needs its user and assistant message ids before it reaches a harness")
  return {
    turnId: prompt.assistantMessageId,
    userMessageId: prompt.userMessageId,
    assistantMessageId: prompt.assistantMessageId,
    prompt: rest,
    ...(model ? { model } : {}),
    ...(variant !== undefined ? { effort: variant } : {}),
    ...(system !== undefined ? { system } : {}),
    todos,
    origin,
  }
}
