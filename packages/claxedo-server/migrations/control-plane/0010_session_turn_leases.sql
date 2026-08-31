-- Durable exactly-one prompt admission. The active row is replaced only after
-- release or expiry, and every replacement advances a monotonic fencing token.
-- Runtime producers retain this generation and stop publication when their
-- renewable ownership proof expires or a later generation takes over.

create table session_turn_leases (
  session_id text primary key,
  workspace_id text not null,
  org_id text not null,
  project_id text not null,
  turn_id text not null,
  lease_id text not null unique,
  fencing_token integer not null check (fencing_token >= 1),
  actor_id text not null references actors (actor_id) deferrable initially deferred,
  acquired_at integer not null,
  expires_at integer not null check (expires_at > acquired_at),
  released_at integer,
  foreign key (session_id, workspace_id, org_id, project_id)
    references sessions (session_id, workspace_id, org_id, project_id) deferrable initially deferred
);

create index session_turn_leases_by_expiry
  on session_turn_leases (released_at, expires_at, session_id);

create trigger session_turn_lease_scope_immutable
before update of session_id, workspace_id, org_id, project_id
on session_turn_leases
when new.session_id != old.session_id
  or new.workspace_id != old.workspace_id
  or new.org_id != old.org_id
  or new.project_id != old.project_id
BEGIN
  select raise(abort, 'session turn lease scope is immutable');
end;
