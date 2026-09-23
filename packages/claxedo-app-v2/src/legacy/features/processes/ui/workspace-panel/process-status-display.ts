import type { Process } from "@/features/processes/data/process"

type ProcessStatus = Process.Status

/**
 * Single source of truth for the process lifecycle status palette and labels
 * shared by the workspace-panel process surfaces (ProcessPanePanel and
 * WorkspaceProcessesNavigator). Keeping one table means a new
 * `Process.Status` value or a palette re-tune is a compiler-checked
 * single-edit instead of two hand-synced copies.
 */
export const PROCESS_STATUS_COLORS: Record<ProcessStatus, string> = {
  idle: "var(--icon-base)",
  starting: "var(--surface-success-strong)",
  running: "var(--surface-success-strong)",
  stopping: "var(--icon-base)",
  stopped: "var(--icon-base)",
  crashed: "var(--surface-critical-strong)",
  restarting: "var(--surface-success-strong)",
}

export const PROCESS_STATUS_LABELS: Record<ProcessStatus, string> = {
  idle: "Idle",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  crashed: "Crashed",
  restarting: "Restarting",
}
