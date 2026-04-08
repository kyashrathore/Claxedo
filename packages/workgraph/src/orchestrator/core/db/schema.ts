import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  run_id: text('run_id').notNull(),
  stream_id: text('stream_id').notNull(),
  stream_seq: integer('stream_seq').notNull(),
  logical_ts: integer('logical_ts').notNull(),
  schema_version: integer('schema_version').notNull(),
  type: text('type').notNull(),
  payload_json: text('payload_json').notNull(),
  actor_type: text('actor_type').notNull(),
  actor_id: text('actor_id').notNull(),
  op_id: text('op_id').notNull().unique(), // Key for idempotency
  prev_hash: text('prev_hash').notNull(),
  hash: text('hash').notNull(),
  created_at: text('created_at').notNull(),
});

export const runs_current = sqliteTable('runs_current', {
  run_id: text('run_id').primaryKey(),
  goal: text('goal').notNull(),
  status: text('status').notNull(),
  source_id: text('source_id'),
  metrics_json: text('metrics_json'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
});

export const nodes_current = sqliteTable('nodes_current', {
  node_id: text('node_id').primaryKey(),
  run_id: text('run_id').notNull(),
  role: text('role').notNull().default('developer'),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  node_type: text('node_type').notNull().default('task'),
  status: text('status').notNull(),
  retry_count: integer('retry_count').notNull(),
});

export const dependency_edges_current = sqliteTable('dependency_edges_current', {
  id: text('id').primaryKey(),
  run_id: text('run_id').notNull(),
  source_id: text('source_id').notNull(),
  target_id: text('target_id').notNull(),
  type: text('type').notNull(),
});

// ---------------------------------------------------------------------------
// Execution tracking
// ---------------------------------------------------------------------------

export const attempts_current = sqliteTable('attempts_current', {
  attempt_id: text('attempt_id').primaryKey(),
  run_id: text('run_id').notNull(),
  node_id: text('node_id').notNull(),
  status: text('status').notNull(),
  runtime_type: text('runtime_type').notNull(),
  directory: text('directory'),
  worktree_path: text('worktree_path'),
  session_id: text('session_id').notNull(),
  pty_id: text('pty_id'),
  started_at: text('started_at').notNull(),
  finished_at: text('finished_at'),
  last_heartbeat_at: text('last_heartbeat_at').notNull(),
});

/** Current runtime context for a run (upserted on each agent spawn). */
export const run_exec_current = sqliteTable('run_exec_current', {
  run_id: text('run_id').primaryKey(),
  runtime_type: text('runtime_type').notNull(),
  session_id: text('session_id').notNull(),
  pty_id: text('pty_id'),
  directory: text('directory'),
  updated_at: text('updated_at').notNull(),
});

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export const run_sources_current = sqliteTable('run_sources_current', {
  run_id: text('run_id').primaryKey(),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  source_path: text('source_path'),
  created_at: text('created_at').notNull(),
});

export const sources_current = sqliteTable('sources_current', {
  source_id: text('source_id').primaryKey(),
  status: text('status').notNull(),
  error: text('error'),
  plan_run_id: text('plan_run_id'),
  last_run_id: text('last_run_id'),
  updated_at: text('updated_at').notNull(),
});

// ---------------------------------------------------------------------------
// Work items linking
// ---------------------------------------------------------------------------

/** Maps graph nodes to external work items (issues, tasks, etc.). */
export const run_node_items_current = sqliteTable('run_node_items_current', {
  id: text('id').primaryKey(),
  run_id: text('run_id').notNull(),
  node_id: text('node_id').notNull(),
  work_item_id: text('work_item_id').notNull(),
});

// ---------------------------------------------------------------------------
// Blockers
// ---------------------------------------------------------------------------

/** Active blockers preventing node execution (e.g. human approval gates). */
export const run_blockers_current = sqliteTable('run_blockers_current', {
  id: text('id').primaryKey(),
  run_id: text('run_id').notNull(),
  target_node_id: text('target_node_id').notNull(),
  reason: text('reason').notNull(),
  created_at: text('created_at').notNull(),
});

// ---------------------------------------------------------------------------
// Sync & conflict resolution
// ---------------------------------------------------------------------------

export const sync_outbox = sqliteTable('sync_outbox', {
  id: text('id').primaryKey(),
  run_id: text('run_id').notNull(),
  event_id: text('event_id').notNull(),
  status: text('status').notNull(),
  retry_count: integer('retry_count').notNull(),
  next_retry_at: text('next_retry_at'),
});

export const sync_state = sqliteTable('sync_state', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  cursor: text('cursor').notNull(),
  last_sync_at: text('last_sync_at').notNull(),
});

export const conflicts = sqliteTable('conflicts', {
  id: text('id').primaryKey(),
  run_id: text('run_id').notNull(),
  event_id: text('event_id').notNull(),
  strategy: text('strategy').notNull(),
  resolution: text('resolution'),
  resolved_at: text('resolved_at'),
});

export const snapshots = sqliteTable('snapshots', {
  id: text('id').primaryKey(),
  run_id: text('run_id').notNull(),
  state_json: text('state_json').notNull(),
  event_seq: integer('event_seq').notNull(),
  created_at: text('created_at').notNull(),
});

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

/**
 * Append-only trace events table.
 * Rows are never updated or deleted — each row is an immutable point-in-time
 * observation of what happened during a run.  Underpins the trace view and
 * all execution instrumentation.
 */
export const trace_events = sqliteTable('trace_events', {
  id: text('id').primaryKey(),
  event_type: text('event_type').notNull(),
  timestamp: text('timestamp').notNull(),
  run_id: text('run_id').notNull(),
  /** NULL for run-scoped events; set for node-scoped events. */
  node_id: text('node_id'),
  payload_json: text('payload_json').notNull(),
});

export const scratchpad_entries = sqliteTable('scratchpad_entries', {
  id: text('id').primaryKey(),
  run_id: text('run_id').notNull(),
  node_id: text('node_id').notNull(),
  content: text('content').notNull(),
  created_at: text('created_at').notNull(),
  expires_at: text('expires_at').notNull(),
  size_bytes: integer('size_bytes').notNull(),
});
