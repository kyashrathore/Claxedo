export const TRACE_EVENT_TYPES = {
  // Run lifecycle
  RUN_CREATED: "run_created",
  RUN_COMPLETED: "run_completed",
  RUN_FAILED: "run_failed",
  RUN_CANCELLED: "run_cancelled",
  // Planning
  PLANNING_START: "planning_start",
  PLANNING_END: "planning_end",
  // Node lifecycle
  NODE_STARTED: "node_started",
  NODE_COMPLETED: "node_completed",
  NODE_FAILED: "node_failed",
  NODE_RETRIED: "node_retried",
  // Agent-emitted (via MCP tools)
  TOOL_USED: "tool_used",
  ARTIFACT_PRODUCED: "artifact_produced",
  // Provenance
  SOURCE_ATTACHED: "source_attached",
  TRIGGER_SPAWNED: "trigger_spawned",
} as const;

export type TraceEventType = typeof TRACE_EVENT_TYPES[keyof typeof TRACE_EVENT_TYPES];
