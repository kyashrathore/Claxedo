-- Provider-neutral application authority. Authentication provider tables stay
-- in AUTH_DB; every identifier below is an application-owned canonical ID.

create table users (
  user_id text primary key,
  state text not null check (state in ('active', 'suspended', 'deleted')),
  created_at integer not null,
  updated_at integer not null,
  suspended_at integer,
  deleted_at integer,
  check ((state = 'suspended') = (suspended_at is not null)),
  check ((state = 'deleted') = (deleted_at is not null))
);

create table auth_identities (
  adapter text not null check (adapter in ('better-auth', 'clerk')),
  issuer text not null,
  subject text not null,
  user_id text not null references users (user_id) deferrable initially deferred,
  linked_at integer not null,
  unlinked_at integer,
  primary key (adapter, issuer, subject)
);

create index auth_identities_by_user
  on auth_identities (user_id, unlinked_at);

create table actors (
  actor_id text primary key,
  user_id text references users (user_id) deferrable initially deferred,
  kind text not null check (kind in ('human', 'agent')),
  state text not null check (state in ('active', 'suspended', 'revoked')),
  created_at integer not null,
  updated_at integer not null,
  revoked_at integer,
  check ((kind = 'human' and user_id is not null) or kind = 'agent'),
  check ((state = 'revoked') = (revoked_at is not null))
);

create unique index actors_one_human_per_user
  on actors (user_id) where kind = 'human';

create table orgs (
  org_id text primary key,
  name text not null,
  kind text not null check (kind in ('personal', 'team', 'deployment')),
  owner_user_id text not null references users (user_id) deferrable initially deferred,
  deployment_id text,
  created_at integer not null,
  updated_at integer not null,
  deleted_at integer,
  check ((kind = 'deployment') = (deployment_id is not null))
);

create unique index orgs_one_personal_per_owner
  on orgs (owner_user_id) where kind = 'personal' and deleted_at is null;

create unique index orgs_one_org_per_deployment
  on orgs (deployment_id) where kind = 'deployment' and deleted_at is null;

create table org_memberships (
  org_id text not null references orgs (org_id) deferrable initially deferred,
  user_id text not null references users (user_id) deferrable initially deferred,
  role text not null check (role in ('member', 'admin', 'owner')),
  created_at integer not null,
  updated_at integer not null,
  revoked_at integer,
  primary key (org_id, user_id)
);

create index org_memberships_by_user
  on org_memberships (user_id, revoked_at, org_id);

create table projects (
  project_id text primary key,
  org_id text not null references orgs (org_id) deferrable initially deferred,
  repo_key text not null,
  owner_user_id text not null references users (user_id) deferrable initially deferred,
  created_at integer not null,
  updated_at integer not null,
  deleted_at integer,
  unique (project_id, org_id),
  unique (org_id, repo_key)
);

create index projects_by_owner
  on projects (owner_user_id, deleted_at, project_id);

create table project_memberships (
  project_id text not null references projects (project_id) deferrable initially deferred,
  user_id text not null references users (user_id) deferrable initially deferred,
  role text not null check (role in ('viewer', 'editor', 'admin', 'owner')),
  created_at integer not null,
  updated_at integer not null,
  revoked_at integer,
  primary key (project_id, user_id)
);

create index project_memberships_by_user
  on project_memberships (user_id, revoked_at, project_id);

create table workspaces (
  workspace_id text primary key,
  org_id text not null,
  project_id text not null,
  owner_user_id text not null references users (user_id) deferrable initially deferred,
  backing text not null check (backing in ('local-worktree', 'cloud-vm')),
  access text not null check (access in ('user-hosted', 'cloud')),
  display_name text not null,
  home_region text,
  repo_url text,
  repo_name text,
  git_branch text,
  remote_directory text,
  created_at integer not null,
  updated_at integer not null,
  deleted_at integer,
  foreign key (project_id, org_id) references projects (project_id, org_id) deferrable initially deferred
);

create index workspaces_by_org
  on workspaces (org_id, deleted_at, workspace_id);

create index workspaces_by_project
  on workspaces (project_id, deleted_at, workspace_id);

create index workspaces_by_owner
  on workspaces (owner_user_id, deleted_at, workspace_id);

create table workspace_memberships (
  workspace_id text not null references workspaces (workspace_id) deferrable initially deferred,
  user_id text not null references users (user_id) deferrable initially deferred,
  role text not null check (role in ('viewer', 'editor', 'admin', 'owner')),
  created_at integer not null,
  updated_at integer not null,
  revoked_at integer,
  primary key (workspace_id, user_id)
);

create index workspace_memberships_by_user
  on workspace_memberships (user_id, revoked_at, workspace_id);

-- D1 batch operations use a final checked insert to make a zero-row guarded
-- write abort the whole fixed batch. Successful batches delete their assertion
-- in the same transaction, so this table is empty at rest.
create table authority_batch_assertions (
  assertion_id text primary key,
  passed integer not null check (passed = 1)
);

create trigger auth_identities_user_immutable
before update of user_id on auth_identities
when new.user_id != old.user_id
BEGIN
  select raise(abort, 'auth identity user is immutable');
end;

create trigger actors_identity_immutable
before update of user_id, kind on actors
when new.user_id is not old.user_id or new.kind != old.kind
BEGIN
  select raise(abort, 'actor identity is immutable');
end;

create trigger projects_scope_immutable
before update of org_id, repo_key on projects
when new.org_id != old.org_id or new.repo_key != old.repo_key
BEGIN
  select raise(abort, 'project scope is immutable');
end;

create trigger workspaces_scope_immutable
before update of org_id, project_id on workspaces
when new.org_id != old.org_id or new.project_id != old.project_id
BEGIN
  select raise(abort, 'workspace scope is immutable');
end;
