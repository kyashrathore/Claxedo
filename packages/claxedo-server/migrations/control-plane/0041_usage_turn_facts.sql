-- The latest usage revision of every turn a cloud workspace runtime reported:
-- session reference, harness, provider, model, token counts and timestamps,
-- never content. `org_id`/`user_id` name the account that produced the turn
-- `turn_id` names, resolved by the plane from session_turn_producers, never
-- from the report. A replayed revision is compared by `payload_hash`; a lower
-- revision never replaces a higher one.

create table usage_turn_facts (
  host_id text not null,
  session_ref text not null,
  session_id text not null,
  message_id text not null,
  revision integer not null check (revision >= 1),
  payload_hash text not null,
  org_id text not null,
  user_id text not null,
  turn_id text not null,
  workspace_id text,
  observed_at integer not null,
  completed_at integer,
  settlement text not null check (settlement in ('provisional', 'final', 'partial', 'unavailable', 'recovered')),
  status text not null check (status in ('running', 'completed', 'error', 'stopped', 'interrupted_by_steer', 'process_lost')),
  location text not null check (location in ('local', 'cloud-workspace')),
  harness text not null,
  provider_id text not null,
  model_id text not null,
  native_session_id text,
  input_tokens integer,
  output_tokens integer,
  reasoning_tokens integer,
  cache_read_tokens integer,
  cache_write_tokens integer,
  cache_write_1h_tokens integer,
  quality_json text not null,
  recorded_at integer not null,
  primary key (host_id, session_ref, message_id)
);

create index usage_turn_facts_by_owner_observed
  on usage_turn_facts (org_id, user_id, observed_at);

create index usage_turn_facts_by_turn
  on usage_turn_facts (host_id, session_ref, turn_id);
