import type { PromptModel, SessionConfig, SessionHarness } from "./index"
import { harnessKey } from "./harness-types"

const NATIVE_COMPATIBILITY_MODEL: PromptModel = {
  providerID: "anthropic",
  modelID: "claude-sonnet-4-6",
}

/**
 * Resolve the model attached to a turn when the caller did not select one.
 *
 * ACP model selection belongs to the connected agent. `default` is a protocol
 * hand-off marker: the adapter leaves the agent's advertised/current model in
 * control. Native compatibility sessions retain their existing default.
 */
export function defaultSessionModel(harness: SessionHarness): PromptModel {
  if (harness.access === "acp") {
    const providerID = harnessKey(harness)
    if (!providerID) throw new Error(`Invalid ACP harness identity: ${harness.id}`)
    return { providerID, modelID: "default" }
  }
  return NATIVE_COMPATIBILITY_MODEL
}

export function resolveSessionModel(config: SessionConfig): PromptModel {
  return config.model ?? defaultSessionModel(config.harness)
}
