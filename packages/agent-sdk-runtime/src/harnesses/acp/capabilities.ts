import type { SessionConfig } from "../../index"
import { harnessCapabilities, type HarnessCapabilities } from "../../capabilities"
import { NO_HARNESS_EFFORT } from "@claxedo/agent-runtime-contract"
import { acpEffortLevels, type AcpConfigOptions } from "./session"

export function acpSessionConfig(
  harness: string,
  currentModel: string,
  model?: SessionConfig["model"],
): SessionConfig["model"] {
  if (model) return model
  return currentModel ? { providerID: harness, modelID: currentModel } : undefined
}

export function acpHarnessCapabilities(input: {
  harness: string
  fork: boolean
  goals: boolean
  subagents?: boolean
  child?: boolean
  modelSelection?: HarnessCapabilities["modelSelection"]
  config?: AcpConfigOptions
}): HarnessCapabilities {
  return harnessCapabilities({
    harness: input.harness,
    modelSelection: input.child ? { status: "unsupported" } : input.modelSelection ?? { status: "optional" },
    abort: !input.child,
    reconnect: false,
    replay: true,
    permissions: true,
    questions: true,
    todos: false,
    commands: false,
    fork: !input.child && input.fork,
    revert: false,
    unrevert: false,
    configOptions: !input.child,
    subagents: input.subagents ?? false,
    goals: !input.child && input.goals,
    effortLevels: input.child ? NO_HARNESS_EFFORT : acpEffortLevels(input.config),
    instructionChannel: "prompt-prefix",
  })
}
