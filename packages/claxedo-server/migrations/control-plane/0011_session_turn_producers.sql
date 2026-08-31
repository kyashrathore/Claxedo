-- Immutable provenance for every admitted user-message turn. The current
-- lease row is replaceable, but snapshot synchronization needs the original
-- producer after later generations have taken over.

create table session_turn_producers (
  session_id text not null,
  workspace_id text not null,
  org_id text not null,
  project_id text not null,
  turn_id text not null,
  fencing_token integer not null check (fencing_token >= 1),
  actor_id text not null references actors (actor_id) deferrable initially deferred,
  admitted_at integer not null,
  primary key (session_id, turn_id),
  unique (session_id, fencing_token),
  foreign key (session_id, workspace_id, org_id, project_id)
    references sessions (session_id, workspace_id, org_id, project_id) deferrable initially deferred
);

create trigger session_turn_producer_after_insert
after insert on session_turn_leases
BEGIN
  insert into session_turn_producers (
    session_id, workspace_id, org_id, project_id, turn_id, fencing_token, actor_id, admitted_at
  ) values (
    new.session_id, new.workspace_id, new.org_id, new.project_id,
    new.turn_id, new.fencing_token, new.actor_id, new.acquired_at
  );
end;

create trigger session_turn_producer_after_takeover
after update of turn_id, fencing_token on session_turn_leases
when new.fencing_token != old.fencing_token
BEGIN
  insert into session_turn_producers (
    session_id, workspace_id, org_id, project_id, turn_id, fencing_token, actor_id, admitted_at
  ) values (
    new.session_id, new.workspace_id, new.org_id, new.project_id,
    new.turn_id, new.fencing_token, new.actor_id, new.acquired_at
  );
end;
