/**
 * A single decomposed task from the planner.
 */
export interface DecomposedTask {
  id: string;
  title: string;
  kind: string;
  team: string;
  prompt: string;
  depends_on: string[];
}

/**
 * The planner's full output: teams, tasks, and a summary.
 */
export interface DecompositionPlan {
  teams: Array<{ id: string; name: string }>;
  tasks: DecomposedTask[];
  summary: string;
}

/**
 * Phases of an orchestration run.
 */
export type RunPhase =
  | "planning"
  | "building_graph"
  | "planned"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled";

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
  plan: DecompositionPlan | null;
  /** Maps planner task id → DB node_id */
  task_node_map: Map<string, string>;
  /** Maps planner team id → DB team_id */
  team_id_map: Map<string, string>;
  /** Maps node_id → agent history for active/past workers */
  node_agents: Map<string, NodeAgentHistory>;
  /** Execution poll interval handle */
  interval: ReturnType<typeof setInterval> | null;
  error: string | null;
  created_at: string;
  /** Aggregated final result when run completes */
  result: string | null;
  /** Optional WorkGraph item linked to this run */
  work_item_id?: string;
  /** Maps node_id → WorkGraph item ID for per-node items created during planning */
  node_work_items: Map<string, string>;
}
