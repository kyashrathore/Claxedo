export const TRACE_EVENT_TYPES = {
  RUN_CREATED: "run_created",
  SOURCE_ATTACHED: "source_attached",
  PLANNING_START: "planning_start",
  PLANNING_END: "planning_end",
  NODE_CREATED: "node_created",
  NODE_STARTED: "node_started",
  NODE_COMPLETED: "node_completed",
  NODE_FAILED: "node_failed",
  NODE_RETRIED: "node_retried",
  RUNTIME_SELECTED: "runtime_selected",
  TOOL_USED: "tool_used",
  ARTIFACT_PRODUCED: "artifact_produced",
  RUN_COMPLETED: "run_completed",
  RUN_FAILED: "run_failed",
  /** Emitted on a spawned run to record which trigger sourced it. */
  TRIGGER_SPAWNED: "trigger_spawned",
} as const;

export type TraceEventType = typeof TRACE_EVENT_TYPES[keyof typeof TRACE_EVENT_TYPES];
