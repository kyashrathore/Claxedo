export const EVENT_TYPES = {
  // Run lifecycle [MVP]
  RUN_CREATED: "run_created",
  RUN_PLANNED: "run_planned",

  // Graph structure [MVP]
  NODE_CREATED: "node_created",
  NODE_STATUS_CHANGED: "node_status_changed",
  EDGE_ADDED: "edge_added",
  EDGE_REMOVED: "edge_removed",

  // Gates [MVP]
  GATE_SATISFIED: "gate_satisfied",
  GATE_REOPENED: "gate_reopened",

  // Scratchpad [MVP]
  SCRATCHPAD_WRITTEN: "scratchpad_written",
  SCRATCHPAD_PROMOTED: "scratchpad_promoted",
  SCRATCHPAD_DISMISSED: "scratchpad_dismissed",

  // Artifacts [MVP]
  ARTIFACT_CREATED: "artifact_created",

  // Execution [MVP]
  DISPATCH_REQUESTED: "dispatch_requested",

  // Hydration and sync
  ISSUE_HYDRATED: "issue_hydrated",
  ISSUE_UPDATED: "issue_updated",
  ISSUE_LINKED: "issue_linked",
  ISSUE_COMMENT_ADDED: "issue_comment_added",

  // Sync protocol
  SYNC_PUSH_ACKED: "sync_push_acked",
  SYNC_PULL_APPLIED: "sync_pull_applied",
  CONFLICT_DETECTED: "conflict_detected",
  CONFLICT_RESOLVED: "conflict_resolved",
  SNAPSHOT_CREATED: "snapshot_created",
  REPAIR_REBUILD_COMPLETED: "repair_rebuild_completed",
} as const;

export type EventType = typeof EVENT_TYPES[keyof typeof EVENT_TYPES];
