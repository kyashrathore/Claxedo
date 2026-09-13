import type { SessionConfig } from "../../index"
import { harnessCapabilities, type HarnessCapabilities } from "../../capabilities"
import { NO_HARNESS_EFFORT } from "@claxedo/agent-runtime-contract"

export function acpSessionConfig(
  harness: string,
  currentModel: string,
  model?: SessionConfig["model"],
): NonNullable<SessionConfig["model"]> {
  if (model) return model
  return { providerID: harness, modelID: currentModel || "default" }
}

export function acpHarnessCapabilities(input: {
  harness: string
  fork: boolean
  goals: boolean
}): HarnessCapabilities {
  return harnessCapabilities({
    harness: input.harness,
    modelSelection: { status: "optional" },
    abort: true,
    reconnect: false,
    replay: true,
    permissions: true,
    questions: false,
    todos: false,
    commands: false,
    fork: input.fork,
    revert: false,
    unrevert: false,
    configOptions: true,
    subagents: false,
    goals: input.goals,
    effortLevels: NO_HARNESS_EFFORT,
  })
}
