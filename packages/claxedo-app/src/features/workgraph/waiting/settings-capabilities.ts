/**
 * Capability catalog for execution settings. The backend does not yet expose an
 * enumerable catalog of harness/agent/model/effort/tool options (defaults() only
 * returns the CONFIGURED values, not the available ones), and this feature may
 * not import the shared Session selectors (`@/features/session/*`). So the
 * capability-driven settings subsections are built around these strict typed
 * props. When `capabilities` is absent the dialog shows current values read-only
 * and surfaces an explicit "options unavailable" state rather than inventing
 * choices. See the report for the exact missing integration point.
 */
export type SettingsCapabilities = {
  harnesses: readonly string[]
  agents: readonly string[]
  /** Model options as provider/model pairs with a display label. */
  models: readonly { providerId: string; modelId: string; label: string }[]
  efforts: readonly string[]
  tools: readonly string[]
  /** Optional base-revision suggestions (e.g. branches). */
  baseRevisions?: readonly string[]
}

/** Contract enums that are always safe to offer (not capability-gated). */
export const ENVIRONMENT_OPTIONS = [
  { value: "local_worktree", label: "Local worktree" },
  { value: "hosted_workspace", label: "Cloud workspace" },
] as const

export const ISOLATION_OPTIONS = [
  { value: "stream", label: "Stream" },
  { value: "child", label: "Child" },
] as const

export const CLEANUP_OPTIONS = [
  { value: "destroy_on_close", label: "Destroy on close" },
  { value: "retain", label: "Retain" },
] as const

export const INTEGRATION_OPTIONS = [
  { value: "manual", label: "Manual" },
  { value: "pull_request", label: "Pull request" },
  { value: "direct", label: "Direct" },
] as const
