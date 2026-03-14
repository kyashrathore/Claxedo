/**
 * Which execution environment a run or node targets.
 * - workspace: code work backed by a repo/workdir; needs terminal + git + filesystem
 * - task:      non-code reasoning/analysis/summarization; uses sandbox + network + artifacts
 * - service:   background hosting, schedules, webhooks, always-available triggers
 */
export type RuntimeType = "workspace" | "task" | "service";

/**
 * How the runtime_type was chosen.
 * - user-specified:    caller explicitly set runtime_type
 * - planner-heuristic: auto-assigned based on node kind
 * - escalated:         upgraded at runtime (e.g. task → workspace on capability error)
 * - inherited:         copied from run-level default
 */
export type RuntimeTypeReason =
  | "user-specified"
  | "planner-heuristic"
  | "escalated"
  | "inherited";

/**
 * Phases of an orchestration run.
 */
export type RunPhase =
  | "draft"
  | "planning"
  | "planned"
  | "executing"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Minimal task descriptor for the adapter-backed executor.
 * Full task data lives in the DB (nodes_current + scratchpad_entries);
 * this interface carries only the data needed to compose prompts.
 */
export interface TaskInfo {
  title: string;
  kind: string;
  prompt: string;
}

/**
 * Tracks all agents that have worked on a node.
 */
export interface NodeAgentHistory {
  current_agent_id: string | null;
  history: Array<{
    agent_id: string;
    status: "running" | "completed" | "failed" | "cancelled";
    started_at: string;
    finished_at: string | null;
  }>;
}

/**
 * In-memory state for an active orchestration run.
 */
export interface OrchestratorRunState {
  run_id: string;
  phase: RunPhase;
  auto_execute: boolean;
  planner_agent_id: string | null;
  /** Maps node_id -> agent history for active/past workers */
  node_agents: Map<string, NodeAgentHistory>;
  error: string | null;
  created_at: string;
  /** Aggregated final result when run completes */
  result: string | null;
  /** Optional WorkGraph item linked to this run */
  work_item_id?: string;
  /** Maps node_id -> WorkGraph item ID for per-node items created during planning */
  node_work_items: Map<string, string>;
}
