-- Authenticated channel identity bindings and provider-neutral runtime-token
-- claims. This is a hard cut: pre-canonical runtime tokens are deliberately
-- discarded so a token without actor/principal/role claims fails closed.

create table channel_identity_bindings (
  binding_id text primary key,
  deployment_id text not null,
  channel text not null,
  external_user_id text not null,
  user_id text not null references users (user_id) deferrable initially deferred,
  actor_id text not null references actors (actor_id) deferrable initially deferred,
  bound_by_actor_id text not null references actors (actor_id) deferrable initially deferred,
  created_at integer not null,
  revoked_at integer,
  unique (binding_id, deployment_id)
);

create unique index channel_identity_bindings_active_external
  on channel_identity_bindings (deployment_id, channel, external_user_id)
  where revoked_at is null;

create index channel_identity_bindings_by_actor
  on channel_identity_bindings (deployment_id, actor_id, revoked_at, created_at);

create trigger channel_identity_binding_intent_immutable
before update of deployment_id, channel, external_user_id, user_id, actor_id,
  bound_by_actor_id, created_at
on channel_identity_bindings
when new.deployment_id != old.deployment_id
  or new.channel != old.channel
  or new.external_user_id != old.external_user_id
  or new.user_id != old.user_id
  or new.actor_id != old.actor_id
  or new.bound_by_actor_id != old.bound_by_actor_id
  or new.created_at != old.created_at
begin
  select raise(abort, 'channel identity binding intent is immutable');
end;

drop table runtime_access_tokens;

create table runtime_access_tokens (
  jti text primary key,
  deployment_id text not null,
  workspace_id text not null,
  org_id text not null,
  project_id text not null,
  host_id text not null,
  principal_kind text not null check (principal_kind in ('user', 'service')),
  actor_id text not null,
  actor_kind text not null check (actor_kind in ('human', 'agent')),
  role text not null check (role in ('viewer', 'editor', 'admin', 'owner')),
  minted_for_user_id text references users (user_id) deferrable initially deferred,
  expires_at integer not null,
  revoked_at integer,
  created_at integer not null,
  foreign key (workspace_id, org_id, project_id)
    references workspaces (workspace_id, org_id, project_id) deferrable initially deferred,
  check (
    (principal_kind = 'user' and actor_kind = 'human' and minted_for_user_id is not null)
    or (principal_kind = 'service' and actor_kind = 'agent' and minted_for_user_id is null)
  )
);

create index runtime_access_tokens_by_workspace_user
  on runtime_access_tokens (workspace_id, minted_for_user_id, revoked_at, expires_at);

create index runtime_access_tokens_by_workspace_host
  on runtime_access_tokens (deployment_id, workspace_id, host_id, revoked_at, expires_at);

create index runtime_access_tokens_by_actor_host
  on runtime_access_tokens (deployment_id, actor_id, host_id, revoked_at, expires_at);

create trigger runtime_access_token_intent_immutable
before update of deployment_id, workspace_id, org_id, project_id, host_id,
  principal_kind, actor_id, actor_kind, role, minted_for_user_id, expires_at, created_at
on runtime_access_tokens
when new.deployment_id != old.deployment_id
  or new.workspace_id != old.workspace_id
  or new.org_id != old.org_id
  or new.project_id != old.project_id
  or new.host_id != old.host_id
  or new.principal_kind != old.principal_kind
  or new.actor_id != old.actor_id
  or new.actor_kind != old.actor_kind
  or new.role != old.role
  or new.minted_for_user_id is not old.minted_for_user_id
  or new.expires_at != old.expires_at
  or new.created_at != old.created_at
begin
  select raise(abort, 'runtime access token intent is immutable');
end;
