/**
 * Phases of an orchestration run.
 */
export type RunPhase =
  | "planning"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Minimal task descriptor used by execution backends and session bridge.
 * In the MCP-driven model, full task data lives in the DB (nodes_current +
 * scratchpad_entries). This interface carries just enough for backends that
 * still accept a task object.
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
    status: "running" | "completed" | "failed";
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
