import type { AgentConfigOption } from "@claxedo/agent-runtime-contract"
import type { ConfigOptionsPreview } from "@claxedo/harness/contract"

export type BoundHarnessConfigOption = AgentConfigOption

// The local control route forwards the workspace runtime response unchanged.
export function runtimeHarnessOptionsResponse(options: BoundHarnessConfigOption[]): ConfigOptionsPreview {
  return { options }
}
