-- Private multiplayer sessions are application authority, not authentication
-- provider data. A reserved runtime identifier is intentionally not visible as
-- a session until registration atomically records the creator and participant.

create unique index workspaces_scope_identity
  on workspaces (workspace_id, org_id, project_id);

create table session_registration_operations (
  operation_id text primary key,
  session_id text not null unique,
  workspace_id text not null,
  org_id text not null,
  project_id text not null,
  creator_actor_id text not null references actors (actor_id) deferrable initially deferred,
  operation_kind text not null check (operation_kind in ('create', 'fork')),
  parent_session_id text,
  requested_title text,
  state text not null check (
    state in ('reserved', 'registered', 'reconciliation_required', 'compensation_pending', 'compensated')
  ),
  state_reason text,
  created_at integer not null,
  updated_at integer not null,
  foreign key (workspace_id, org_id, project_id)
    references workspaces (workspace_id, org_id, project_id) deferrable initially deferred,
  check (
    (operation_kind = 'create' and parent_session_id is null)
    or (operation_kind = 'fork' and parent_session_id is not null)
  )
);

create index session_registration_operations_by_state
  on session_registration_operations (state, updated_at, operation_id);

create table sessions (
  session_id text primary key,
  operation_id text not null unique references session_registration_operations (operation_id) deferrable initially deferred,
  workspace_id text not null,
  org_id text not null,
  project_id text not null,
  creator_actor_id text not null references actors (actor_id) deferrable initially deferred,
  lifecycle_generation integer not null check (lifecycle_generation >= 1),
  title text,
  created_at integer not null,
  updated_at integer not null,
  deleted_at integer,
  max_event_ordinal integer not null default 0 check (max_event_ordinal >= 0),
  snapshot_generation integer not null default 0 check (snapshot_generation >= 0),
  snapshot_hash text,
  snapshot_token text,
  unique (session_id, workspace_id, org_id, project_id),
  foreign key (workspace_id, org_id, project_id)
    references workspaces (workspace_id, org_id, project_id) deferrable initially deferred
);

create index sessions_by_workspace_updated
  on sessions (workspace_id, updated_at desc, session_id);

create index sessions_by_creator
  on sessions (workspace_id, creator_actor_id, deleted_at, session_id);

create table session_participants (
  session_id text not null,
  workspace_id text not null,
  org_id text not null,
  project_id text not null,
  actor_id text not null references actors (actor_id) deferrable initially deferred,
  granted_by_actor_id text not null references actors (actor_id) deferrable initially deferred,
  role text not null check (role in ('participant')),
  granted_at integer not null,
  revoked_at integer,
  primary key (session_id, actor_id),
  foreign key (session_id, workspace_id, org_id, project_id)
    references sessions (session_id, workspace_id, org_id, project_id) deferrable initially deferred
);

create index session_participants_by_actor_workspace
  on session_participants (actor_id, workspace_id, revoked_at, session_id);

create table session_messages (
  session_id text not null,
  workspace_id text not null,
  org_id text not null,
  project_id text not null,
  message_id text not null,
  author_actor_id text references actors (actor_id) deferrable initially deferred,
  role text not null,
  ordinal integer not null check (ordinal >= 0),
  data_json text not null check (json_valid(data_json)),
  snapshot_generation integer not null check (snapshot_generation >= 1),
  created_at integer not null,
  updated_at integer not null,
  primary key (session_id, message_id),
  foreign key (session_id, workspace_id, org_id, project_id)
    references sessions (session_id, workspace_id, org_id, project_id) deferrable initially deferred
);

create index session_messages_by_session_ordinal
  on session_messages (session_id, ordinal);

create trigger session_registration_intent_immutable
before update of session_id, workspace_id, org_id, project_id, creator_actor_id,
  operation_kind, parent_session_id, requested_title, created_at
on session_registration_operations
when new.session_id != old.session_id
  or new.workspace_id != old.workspace_id
  or new.org_id != old.org_id
  or new.project_id != old.project_id
  or new.creator_actor_id != old.creator_actor_id
  or new.operation_kind != old.operation_kind
  or new.parent_session_id is not old.parent_session_id
  or new.requested_title is not old.requested_title
  or new.created_at != old.created_at
begin
  select raise(abort, 'session registration intent is immutable');
end;

create trigger session_registration_state_transition
before update of state on session_registration_operations
when new.state != old.state and not (
  (old.state = 'reserved' and new.state in ('registered', 'reconciliation_required', 'compensation_pending'))
  or (old.state = 'reconciliation_required' and new.state in ('registered', 'compensation_pending'))
  or (old.state = 'compensation_pending' and new.state in ('compensated', 'reconciliation_required'))
)
begin
  select raise(abort, 'invalid session registration state transition');
end;

create trigger sessions_scope_immutable
before update of operation_id, workspace_id, org_id, project_id, creator_actor_id,
  lifecycle_generation, created_at
on sessions
when new.operation_id != old.operation_id
  or new.workspace_id != old.workspace_id
  or new.org_id != old.org_id
  or new.project_id != old.project_id
  or new.creator_actor_id != old.creator_actor_id
  or new.lifecycle_generation != old.lifecycle_generation
  or new.created_at != old.created_at
begin
  select raise(abort, 'session scope is immutable');
end;

create trigger session_participant_scope_immutable
before update of session_id, workspace_id, org_id, project_id, actor_id, role, granted_at
on session_participants
when new.session_id != old.session_id
  or new.workspace_id != old.workspace_id
  or new.org_id != old.org_id
  or new.project_id != old.project_id
  or new.actor_id != old.actor_id
  or new.role != old.role
  or new.granted_at != old.granted_at
begin
  select raise(abort, 'session participant scope is immutable');
end;
