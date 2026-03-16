import type { LeaseManager, TeamPolicy } from "./core/scheduler";

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
 * In-memory parallelism tracker for computing run metrics.
 */
export interface ParallelismTracker {
  /** Timestamp (ms) when execution phase started */
  start_ms: number;
  /** Currently active node count */
  current: number;
  /** Peak concurrent node count seen during execution */
  max: number;
  /** Weighted integral: sum of (count * duration_ms) for computing avg */
  integral: number;
  /** Timestamp of the last sample (for integral computation) */
  last_sample_ms: number;
}

/**
 * Lifecycle hooks injected into the orchestrator by external integrations.
 * The orchestrator calls these at well-defined points; it never imports the
 * integration layer directly.
 */
export interface OrchestratorHooks {
  /** Called after planning completes. Bridge can read the plan from DB and build its own mappings. */
  onPlanSynced?(db: any, runId: string, sourceId: string): void;
  /** Called just before a task agent is spawned for a node. */
  onNodeActive?(runId: string, nodeId: string): void;
  /** Called when a node finishes successfully. */
  onNodeCompleted?(runId: string, nodeId: string): Promise<void>;
  /** Called when a node exhausts all retries and is marked failed. */
  onNodeFailed?(runId: string, nodeId: string): void;
  /** Called when the entire run reaches a terminal completed state. */
  onRunCompleted?(runId: string): Promise<void>;
  /** Called when the run is cancelled. */
  onRunCancelled?(runId: string): void;
  /**
   * Called to determine whether a source still has incomplete work items.
   * Return true if work remains (run should be marked "planned" not "completed").
   */
  sourceHasWork?(sourceId: string): boolean;
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
  /** Lifecycle hooks registered by the caller (e.g. workgraph-bridge). */
  hooks?: OrchestratorHooks;
  /** Parallelism tracking for metrics; initialized when execution starts */
  parallelism?: ParallelismTracker;
  /** Manages dispatch leases to prevent duplicate node spawning */
  leaseManager: LeaseManager;
  /** Parallelism caps for this run */
  teamPolicy: TeamPolicy;
  /** Optional map of node_id → WorkGraph work_item_id for item lifecycle tracking */
  node_work_items?: Map<string, string>;
}
