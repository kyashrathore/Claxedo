-- `expires_at` is the claim's lease deadline while `state` is 'in_flight' and
-- the replay deadline once 'completed'. A row past it is claimable and prunable.
create table projection_command_idempotency (
  cache_key text primary key,
  fingerprint text not null,
  state text not null check (state in ('in_flight', 'completed')),
  claim_id text not null,
  result_json text,
  expires_at integer not null
);

create index projection_command_idempotency_expires_at on projection_command_idempotency (expires_at);
