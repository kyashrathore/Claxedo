import type { FrameMetric } from "./frame-sampler"
import type { Measurement, ScenarioId } from "./types"

// Lightweight flow metadata — no playwright import, safe for the CLI to load.
// The actual interaction drivers live in browser-runner.ts, keyed by id. To add
// a flow: add the id to ScenarioId, an entry here, a seed in seed.ts, and a
// driver in browser-runner's `flowDrivers`.
export const FLOWS: { id: ScenarioId; name: string }[] = [
  { id: "launch-project", name: "Launch into a project with 20 sessions" },
  { id: "session-switch", name: "Switch between two 10,000-message sessions (with rapid stress)" },
  { id: "live-terminal-switch", name: "Switch between three live terminals" },
  { id: "large-diff-toggle", name: "Open a 500-file diff and toggle split/unified" },
  { id: "workspace-switch", name: "Switch across five workspaces" },
]

export function flowName(id: ScenarioId) {
  return FLOWS.find((flow) => flow.id === id)?.name ?? id
}

// What every flow driver returns: one user-facing headline (frame timing of the
// flow's primary interaction) plus optional debug sub-metrics (--debug only).
export type FlowResult = {
  headline: FrameMetric
  debug: Measurement[]
}
