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
});

export const teams_current = sqliteTable('teams_current', {
  team_id: text('team_id').primaryKey(),
  run_id: text('run_id').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull(),
});

export const team_members_current = sqliteTable('team_members_current', {
  id: text('id').primaryKey(),
  team_id: text('team_id').notNull(),
  agent_id: text('agent_id').notNull(),
  role: text('role').notNull(),
});

export const nodes_current = sqliteTable('nodes_current', {
  node_id: text('node_id').primaryKey(),
  run_id: text('run_id').notNull(),
  team_id: text('team_id').notNull(),
  kind: text('kind').notNull(),
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

export const messages_current = sqliteTable('messages_current', {
  id: text('id').primaryKey(),
  run_id: text('run_id').notNull(),
  team_id: text('team_id').notNull(),
  sender_id: text('sender_id').notNull(),
  content: text('content').notNull(),
  message_type: text('message_type').notNull(),
  created_at: text('created_at').notNull(),
});

export const handoffs_current = sqliteTable('handoffs_current', {
  id: text('id').primaryKey(),
  run_id: text('run_id').notNull(),
  from_team_id: text('from_team_id').notNull(),
  to_team_id: text('to_team_id').notNull(),
  status: text('status').notNull(),
  payload: text('payload').notNull(),
});

export const artifacts_current = sqliteTable('artifacts_current', {
  id: text('id').primaryKey(),
  run_id: text('run_id').notNull(),
  node_id: text('node_id').notNull(),
  content: text('content').notNull(),
  version: integer('version').notNull(),
  provenance: text('provenance').notNull(),
});

export const decisions_current = sqliteTable('decisions_current', {
  id: text('id').primaryKey(),
  run_id: text('run_id').notNull(),
  proposal: text('proposal').notNull(),
  status: text('status').notNull(),
  challenger_id: text('challenger_id'),
  evidence: text('evidence'),
});

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

export const scratchpad_entries = sqliteTable('scratchpad_entries', {
  id: text('id').primaryKey(),
  run_id: text('run_id').notNull(),
  node_id: text('node_id').notNull(),
  content: text('content').notNull(),
  created_at: text('created_at').notNull(),
  expires_at: text('expires_at').notNull(),
  size_bytes: integer('size_bytes').notNull(),
});
