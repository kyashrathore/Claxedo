import type { FrameMetric } from "./frame-sampler"
import type { WebVitals } from "./web-vitals"
import type { MetricComparison } from "./baseline-store"

export type { FrameMetric, FrameVerdict } from "./frame-sampler"

// The five surviving, user-observable flows. Adding a flow = add an id here and
// a registry entry in flows.ts — no engine changes.
export type ScenarioId =
  | "launch-project"
  | "session-switch"
  | "live-terminal-switch"
  | "large-diff-toggle"
  | "heavy-workspace-reopen"
  | "heavy-workspace-review-resume"
  | "heavy-workspace-close"
  | "workspace-switch"
  | "workspace-lifecycle"
  | "workspace-interactions"
  | "session-switch-workspace"

// We only ever measure our own app, in a real browser. Kept as single literals
// (rather than removed) so storage paths and attribution stay stable.
export type AppTarget = "claxedo"
export type PerfAdapter = "browser"

export type Direction = "lower" | "higher"

// A debug sub-metric: a labeled latency captured inside a flow. Only surfaced
// with --debug. The headline (FrameMetric) is what the default report shows.
export type Measurement = {
  metric: string
  value: number
  unit: string
  direction: Direction
  samples: number[]
}

export type MetricSummary = Measurement & {
  p50: number
  p95: number
  min: number
  max: number
  mean: number
  relative_stddev: number
}

export type SeedManifest = {
  repos: number
  sessions: number
  messages: number
  terminals: number
  changed_files: number
  projects: number
  themes: string[]
  agent_actions: number
  mask_keys: string[]
}

export type RunStatus = "pass" | "warn" | "fail"

export type ScenarioResult = {
  adapter: PerfAdapter
  target: AppTarget
  id: ScenarioId
  name: string
  started_at: string
  duration_ms: number
  seed: SeedManifest
  headline: FrameMetric
  /** Core Web Vitals for this run, and the reference machine that produced them. */
  vitals?: WebVitals
  environment?: { profile: string; label: string }
  metrics: MetricSummary[]
  budget: Budget
  status: RunStatus
  failures: string[]
  warnings: string[]
  /** Per-metric movement against the tracked baseline for this profile+stack. */
  comparison?: MetricComparison[]
  diagnostics?: DiagnosticsOverheadEvidence
  attribution?: RunAttribution
  artifacts?: {
    video?: string
  }
}

export type DiagnosticsOverheadEvidence = {
  retainedBytes: number
  retainedProcesses: number
  droppedTicks: number
  maxSourceDurationMs: number
  maxReconciliationDurationMs: number
  collections: number
  sampleCount: number
  controlHeadline: FrameMetric
  enabledHeadline: FrameMetric
}

// Regression budget: a ceiling on the headline worst renderer interval, auto-calibrated from
// the first accepted run. The 8.33/16.67 renderer-proxy thresholds are enforced
// separately and are not stored.
export type Budget = {
  scenario: ScenarioId
  worst_frame_ms?: number
}

export type Baseline = {
  scenario: ScenarioId
  accepted_at: string
  worst_frame_ms: number
  p95_frame_ms: number
}

export type TrendRecord = {
  scenario: ScenarioId
  recorded_at: string
  status: RunStatus
  seed?: SeedManifest
  attribution?: RunAttribution
  worst_frame_ms: number
  p95_frame_ms: number
  verdict: FrameMetric["verdict"]
}

export type RunAttribution = {
  git_sha: string
  git_branch: string
  git_dirty: boolean
  command: string
  cwd: string
  bun_version: string
  platform: string
  target_package_dir: string
  adapter: PerfAdapter
  browser?: {
    name: "chromium"
    version: string
  }
  server?: {
    base_url: string
    mock_port?: number
    dev_command: string
  }
  app_build_identity: string
}

export type RunOptions = {
  scenarios: ScenarioId[]
  /** Reference hardware/network the flows are measured on (see environment-profile.ts). */
  profile: string
  /**
   * Which implementation produced the run. The axis an experiment varies:
   * hold flow and profile fixed, change this, compare. Defaults to the shipping
   * renderer so today's numbers are attributable rather than anonymous.
   */
  stack: string
  /** Write the run's records as the tracked baseline for (profile, stack). */
  accept_baseline: boolean
  iterations: number
  output: string
  update_baseline: boolean
  append_trend: boolean
  headless: boolean
  debug: boolean
}
