// CONTRACT BINDING:
//   GET /api/claxedo/agent-config/harness/options
//   GET /api/wr/harness-config-options
//
// These endpoints intentionally have different response shapes. The control
// plane wraps options with source/staleness metadata; the workspace runtime is
// the authoritative harness producer and returns its options object. Keeping
// one mock wrapper for both let Tier M accept a route shape production never
// emits.
import type { AgentConfigOption, AgentConfigOptions } from "../../../../agent-sdk-runtime/src"
import type {
  HarnessConfigOption,
  OptionsResponse,
} from "../../../../claxedo-local-server/src/agent-config/harness"
import { liveHarnessOptionsResponse } from "../../../../claxedo-local-server/src/agent-config/harness"

export type BoundHarnessConfigOption = AgentConfigOption & HarnessConfigOption

export function localHarnessOptionsResponse(options: BoundHarnessConfigOption[]): OptionsResponse {
  return liveHarnessOptionsResponse({ options })
}

export function runtimeHarnessOptionsResponse(options: BoundHarnessConfigOption[]): AgentConfigOptions {
  return { options }
}
