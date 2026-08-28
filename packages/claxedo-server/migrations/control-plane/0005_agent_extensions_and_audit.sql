-- Tenant-bound Agent Extension desired state, policy overrides, and bounded
-- control-plane audit events. JSON is validated and byte-bounded at rest;
-- application writes additionally canonicalize it before reaching D1.

create unique index actors_scope_identity
  on actors (actor_id, user_id);

create table agent_extension_installs (
  deployment_id text not null check (length(deployment_id) between 1 and 200),
  workspace_id text not null,
  org_id text not null,
  project_id text not null,
  extension_id text not null check (length(extension_id) between 1 and 300),
  package_name text not null check (length(package_name) between 1 and 300),
  source_json text not null check (json_valid(source_json) and length(cast(source_json as blob)) <= 16384),
  desired_json text not null check (json_valid(desired_json) and length(cast(desired_json as blob)) <= 65536),
  lock_json text check (lock_json is null or (json_valid(lock_json) and length(cast(lock_json as blob)) <= 262144)),
  enabled integer not null check (enabled in (0, 1)),
  created_by_user_id text not null,
  created_by_actor_id text not null,
  updated_by_user_id text not null,
  updated_by_actor_id text not null,
  created_at integer not null,
  updated_at integer not null,
  revision integer not null check (revision >= 1),
  deleted_at integer,
  primary key (deployment_id, workspace_id, extension_id),
  foreign key (workspace_id, org_id, project_id)
    references workspaces (workspace_id, org_id, project_id) deferrable initially deferred,
  foreign key (created_by_actor_id, created_by_user_id)
    references actors (actor_id, user_id) deferrable initially deferred,
  foreign key (updated_by_actor_id, updated_by_user_id)
    references actors (actor_id, user_id) deferrable initially deferred
);

create index agent_extension_installs_by_workspace
  on agent_extension_installs (deployment_id, workspace_id, deleted_at, extension_id);

create trigger agent_extension_install_scope_immutable
before update of deployment_id, workspace_id, org_id, project_id, extension_id,
  created_by_user_id, created_by_actor_id, created_at
on agent_extension_installs
when new.deployment_id != old.deployment_id
  or new.workspace_id != old.workspace_id
  or new.org_id != old.org_id
  or new.project_id != old.project_id
  or new.extension_id != old.extension_id
  or new.created_by_user_id != old.created_by_user_id
  or new.created_by_actor_id != old.created_by_actor_id
  or new.created_at != old.created_at
begin
  select raise(abort, 'agent extension install scope is immutable');
end;

create trigger agent_extension_live_source_immutable
before update of source_json on agent_extension_installs
when old.deleted_at is null and new.source_json != old.source_json
begin
  select raise(abort, 'agent extension live source is immutable');
end;

create table agent_extension_policy_overrides (
  deployment_id text not null check (length(deployment_id) between 1 and 200),
  scope text not null check (scope in ('org', 'user', 'workspace')),
  scope_key text not null check (length(scope_key) between 1 and 300),
  extension_id text not null check (length(extension_id) between 1 and 300),
  org_id text references orgs (org_id) deferrable initially deferred,
  project_id text,
  workspace_id text,
  user_id text references users (user_id) deferrable initially deferred,
  enabled integer not null check (enabled in (0, 1)),
  reason text check (reason is null or length(reason) <= 500),
  created_by_user_id text not null,
  created_by_actor_id text not null,
  updated_by_user_id text not null,
  updated_by_actor_id text not null,
  created_at integer not null,
  updated_at integer not null,
  deleted_at integer,
  primary key (deployment_id, scope, scope_key, extension_id),
  foreign key (workspace_id, org_id, project_id)
    references workspaces (workspace_id, org_id, project_id) deferrable initially deferred,
  foreign key (created_by_actor_id, created_by_user_id)
    references actors (actor_id, user_id) deferrable initially deferred,
  foreign key (updated_by_actor_id, updated_by_user_id)
    references actors (actor_id, user_id) deferrable initially deferred,
  check (
    (scope = 'org' and scope_key = org_id and project_id is null and workspace_id is null and user_id is null)
    or (scope = 'user' and scope_key = user_id and org_id is null and project_id is null and workspace_id is null)
    or (scope = 'workspace' and scope_key = workspace_id and org_id is not null and project_id is not null and user_id is null)
  )
);

create index agent_extension_policies_by_org
  on agent_extension_policy_overrides (deployment_id, org_id, deleted_at, extension_id);

create index agent_extension_policies_by_user
  on agent_extension_policy_overrides (deployment_id, user_id, deleted_at, extension_id);

create index agent_extension_policies_by_workspace
  on agent_extension_policy_overrides (deployment_id, workspace_id, deleted_at, extension_id);

create trigger agent_extension_policy_scope_immutable
before update of deployment_id, scope, scope_key, extension_id, org_id, project_id,
  workspace_id, user_id, created_by_user_id, created_by_actor_id, created_at
on agent_extension_policy_overrides
when new.deployment_id != old.deployment_id
  or new.scope != old.scope
  or new.scope_key != old.scope_key
  or new.extension_id != old.extension_id
  or new.org_id is not old.org_id
  or new.project_id is not old.project_id
  or new.workspace_id is not old.workspace_id
  or new.user_id is not old.user_id
  or new.created_by_user_id != old.created_by_user_id
  or new.created_by_actor_id != old.created_by_actor_id
  or new.created_at != old.created_at
begin
  select raise(abort, 'agent extension policy scope is immutable');
end;

-- Rows are immutable after insert. Retention deletes are deliberately allowed:
-- each writer transaction removes only rows beyond the configured per-
-- deployment cap, keeping storage bounded without rewriting history.
create table authority_audit_events (
  event_id text primary key,
  deployment_id text not null check (length(deployment_id) between 1 and 200),
  user_id text,
  actor_id text,
  org_id text,
  project_id text,
  workspace_id text,
  unverified_attempted_workspace_id text check (
    unverified_attempted_workspace_id is null or length(unverified_attempted_workspace_id) <= 300
  ),
  action text not null check (length(action) between 1 and 200),
  result text not null check (result in ('allow', 'deny')),
  reason text check (reason is null or length(reason) <= 500),
  metadata_json text check (
    metadata_json is null or (json_valid(metadata_json) and length(cast(metadata_json as blob)) <= 4096)
  ),
  created_at integer not null,
  foreign key (actor_id, user_id) references actors (actor_id, user_id) deferrable initially deferred,
  foreign key (workspace_id, org_id, project_id)
    references workspaces (workspace_id, org_id, project_id) deferrable initially deferred,
  check ((actor_id is null and user_id is null) or (actor_id is not null and user_id is not null)),
  check (
    (workspace_id is null and org_id is null and project_id is null)
    or (workspace_id is not null and org_id is not null and project_id is not null)
  ),
  check (workspace_id is null or unverified_attempted_workspace_id is null),
  check ((result = 'allow' and reason is null) or (result = 'deny' and reason is not null))
);

create index authority_audit_events_by_deployment_created
  on authority_audit_events (deployment_id, created_at desc, event_id desc);

create index authority_audit_events_by_workspace_created
  on authority_audit_events (deployment_id, workspace_id, created_at desc, event_id desc);

create index authority_audit_events_by_actor_created
  on authority_audit_events (deployment_id, actor_id, created_at desc, event_id desc);

create trigger authority_audit_events_no_update
before update on authority_audit_events
begin
  select raise(abort, 'authority audit is append-only');
end;
