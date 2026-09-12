import type { AgentConfigOption } from "../../index"
import type { AgentConfigOptions } from "../../adapter-contract"
import { resolvedModelFromConfigOptions } from "../../adapter-contract"
import { harnessCapabilities, type HarnessCapabilities } from "../../capabilities"
import { NO_HARNESS_EFFORT } from "../../harness-effort"
import type { SdkRuntimeDriver } from "./sdk-runtime-driver"

export function sdkConfigOptions(options: AgentConfigOption[]): AgentConfigOptions {
  const resolvedModel = resolvedModelFromConfigOptions(options)
  return { options, ...(resolvedModel ? { resolvedModel } : {}) }
}

export function sdkHarnessCapabilities(driver: SdkRuntimeDriver, directory?: string): HarnessCapabilities {
  return harnessCapabilities({
    harness: driver.type,
    modelSelection: { status: "optional" },
    abort: true,
    reconnect: false,
    replay: true,
    permissions: driver.interactions.permissions,
    questions: driver.interactions.questions,
    todos: driver.type !== "pi",
    commands: false,
    fork: false,
    revert: false,
    unrevert: false,
    configOptions: true,
    subagents: driver.type !== "pi",
    goals: !!driver.goals || !!driver.nativeGoal,
    effortLevels: driver.effortLevels?.(directory) ?? NO_HARNESS_EFFORT,
  })
}
