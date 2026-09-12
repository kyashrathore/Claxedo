import type { PromptModel, SessionConfig, SessionHarness } from "./index"
import { harnessKey } from "./harness-types"

/**
 * The `modelID` a session carries while it has selected no model. Harnesses
 * resolve it themselves: the Claude SDK serves a model row under exactly this
 * id, so the driver forwards it rather than translating it away.
 */
export const DEFAULT_MODEL_ID = "default"

const NATIVE_COMPATIBILITY_MODEL: PromptModel = {
  providerID: "anthropic",
  modelID: "claude-sonnet-4-6",
}

/**
 * Resolve the model attached to a turn when the caller did not select one.
 *
 * SDK and ACP model selection belongs to the selected harness. `default` is a protocol
 * hand-off marker: the adapter leaves the agent's advertised/current model in
 * control. OpenCode compatibility sessions retain their existing default.
 */
export function defaultSessionModel(harness: SessionHarness): PromptModel {
  if (harness.access === "connection" || harness.id !== "opencode") {
    const providerID = harnessKey(harness)
    if (!providerID) throw new Error(`Invalid harness identity: ${harness.id}`)
    return { providerID, modelID: DEFAULT_MODEL_ID }
  }
  return NATIVE_COMPATIBILITY_MODEL
}

export function resolveSessionModel(config: SessionConfig): PromptModel {
  return config.model ?? defaultSessionModel(config.harness)
}

/**
 * The instruction channel of one turn: the session's standing instructions,
 * then a pending handoff transcript, then whatever this turn carries.
 *
 * Retained instructions lead because they say who the session is; the
 * transcript and the turn's own block are what happened after that.
 */
export function resolveTurnSystem(
  config: Pick<SessionConfig, "instructions" | "handoff"> | undefined,
  turnSystem?: string,
): string | undefined {
  const blocks = [
    config?.instructions,
    config?.handoff?.pending ? config.handoff.transcript : undefined,
    turnSystem,
  ].filter((block): block is string => !!block)
  return blocks.length ? blocks.join("\n\n") : undefined
}
