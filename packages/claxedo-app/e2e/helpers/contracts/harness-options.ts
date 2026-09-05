import type { AgentConfigOption, AgentConfigOptions } from "../../../../agent-sdk-runtime/src"

export type BoundHarnessConfigOption = AgentConfigOption

// The local control route forwards the workspace runtime response unchanged.
export function runtimeHarnessOptionsResponse(options: BoundHarnessConfigOption[]): AgentConfigOptions {
  return { options }
}
