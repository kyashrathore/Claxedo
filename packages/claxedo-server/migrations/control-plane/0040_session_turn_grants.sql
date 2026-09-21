-- A deferred turn grant: single-use, expiring admission minted while a live
-- credential proved `agent_turn` on the session, redeemed later by a
-- background turn (child-completion wake, recovered queued prompt) that holds
-- no credential. Exactly one of `turn_id` (queued prompt, fixed at queue time)
-- and `turn_id_prefix` (`msg_wake_<child>_`) names the turn it may admit.
-- Redemption is written in the same batch as the lease insert; the trigger
-- keeps a redeemed row from ever being redeemed again by a later batch.

create table session_turn_grants (
  grant_id text primary key,
  session_id text not null,
  workspace_id text not null,
  org_id text not null,
  project_id text not null,
  actor_id text not null references actors (actor_id) deferrable initially deferred,
  intent text not null check (intent in ('child_completion', 'queued_prompt')),
  subject_session_id text,
  turn_id text,
  turn_id_prefix text,
  issued_at integer not null,
  expires_at integer not null check (expires_at > issued_at),
  redeemed_at integer,
  redeemed_turn_id text,
  revoked_at integer,
  revoke_reason text,
  check ((turn_id is not null) + (turn_id_prefix is not null) = 1),
  foreign key (session_id, workspace_id, org_id, project_id)
    references sessions (session_id, workspace_id, org_id, project_id) deferrable initially deferred
);

create index session_turn_grants_by_session
  on session_turn_grants (session_id, revoked_at);

create index session_turn_grants_by_subject
  on session_turn_grants (subject_session_id, revoked_at);

create trigger session_turn_grant_redeemed_once
before update of redeemed_at, redeemed_turn_id on session_turn_grants
when old.redeemed_at is not null
BEGIN
  select raise(abort, 'session turn grant is already redeemed');
end;
