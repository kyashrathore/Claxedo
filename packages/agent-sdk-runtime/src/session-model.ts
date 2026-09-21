import type { HarnessInstructionChannel } from "@claxedo/agent-runtime-contract"
import type { PromptModel, SessionConfig, SessionHarness } from "./index"
import { harnessKey } from "@claxedo/agent-runtime-contract"

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
 * Connection sessions retain an absent model until selected or reported. Native
 * SDK harnesses retain their default marker, and OpenCode compatibility sessions
 * retain their existing model.
 */
export function defaultSessionModel(harness: SessionHarness): PromptModel | undefined {
  if (harness.access === "connection") return undefined
  if (harness.id !== "opencode") {
    const providerID = harnessKey(harness)
    if (!providerID) throw new Error(`Invalid harness identity: ${harness.id}`)
    return { providerID, modelID: DEFAULT_MODEL_ID }
  }
  return NATIVE_COMPATIBILITY_MODEL
}

export function resolveSessionModel(config: SessionConfig): PromptModel | undefined {
  return config.model ?? defaultSessionModel(config.harness)
}

/**
 * The system block of one turn: the session's standing instructions, then a
 * pending handoff transcript, then whatever this turn carries.
 *
 * Retained instructions lead because they say who the session is; the
 * transcript and the turn's own block are what happened after that. They are
 * left out entirely for a channel that took them once at thread creation —
 * that harness still holds them, and repeating them would send them twice.
 */
export function resolveTurnSystem(
  config: Pick<SessionConfig, "instructions" | "handoff"> | undefined,
  channel: HarnessInstructionChannel,
  turnSystem?: string,
): string | undefined {
  const blocks = [
    channel === "turn-system-prompt" || channel === "prompt-prefix" ? config?.instructions : undefined,
    config?.handoff?.pending ? config.handoff.transcript : undefined,
    turnSystem,
  ].filter((block): block is string => !!block)
  return blocks.length ? blocks.join("\n\n") : undefined
}
