import type { FrameMetric } from "./frame-sampler"
import type { Measurement, ScenarioId } from "./types"

// Lightweight flow metadata — no playwright import, safe for the CLI to load.
// ScenarioId is derived from this catalog. Add a seed and a scenario driver
// for each new entry; there is no second list of supported flow identifiers.
export const FLOWS = [
  { id: "launch-project", name: "Launch into a project with 20 sessions" },
  { id: "session-switch", name: "Switch between two 80-message first folds (rapid cold/warm stress)" },
  { id: "live-terminal-switch", name: "Switch between three attached, already-open terminal surfaces" },
  { id: "large-diff-toggle", name: "Toggle split/unified with a progressively rendered 500-file review" },
  { id: "heavy-workspace-reopen", name: "Reopen a heavy workspace on Review and restore its file working set" },
  { id: "heavy-workspace-review-resume", name: "Resume a fully rendered 500-file Review working set" },
  { id: "heavy-workspace-close", name: "Close and dispose a substantial workspace working set" },
  { id: "workspace-switch", name: "Switch across five workspaces" },
  { id: "workspace-lifecycle", name: "Workspace panel lifecycle phases, each separately clocked" },
  { id: "workspace-interactions", name: "Isolated interactions inside a loaded workspace" },
  { id: "session-switch-workspace", name: "Session switching with the workspace panel closed and open" },
  { id: "transcript-flick", name: "Fast wheel flick down a long transcript, blank viewport area per frame" },
] as const

export function flowName(id: ScenarioId) {
  return FLOWS.find((flow) => flow.id === id)?.name ?? id
}

// What every flow driver returns: one user-facing headline (frame timing of the
// flow's primary interaction) plus optional debug sub-metrics (--debug only).
export type FlowResult = {
  headline: FrameMetric
  debug: Measurement[]
}
