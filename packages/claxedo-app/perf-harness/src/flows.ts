import type { FrameMetric } from "./frame-sampler"
import type { Measurement, ScenarioId } from "./types"

// Lightweight flow metadata — no playwright import, safe for the CLI to load.
// The actual interaction drivers live in browser-runner.ts, keyed by id. To add
// a flow: add the id to ScenarioId, an entry here, a seed in seed.ts, and a
// driver in browser-runner's `flowDrivers`.
export const FLOWS: { id: ScenarioId; name: string }[] = [
  { id: "launch-project", name: "Launch into a project with 20 sessions" },
  { id: "session-switch", name: "Switch between two 80-message first folds (rapid cold/warm stress)" },
  { id: "live-terminal-switch", name: "Switch between three attached, already-open terminal surfaces" },
  { id: "large-diff-toggle", name: "Toggle split/unified with a progressively rendered 500-file review" },
  { id: "heavy-workspace-reopen", name: "Reopen a heavy workspace onto its active file working set" },
  { id: "heavy-workspace-review-resume", name: "Resume a fully rendered 500-file Review working set" },
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
