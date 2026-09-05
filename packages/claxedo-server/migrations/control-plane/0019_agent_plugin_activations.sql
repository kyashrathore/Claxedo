-- Signed Agent Plugins activation metadata, ported from the retired Convex
-- component onto the canonical control-plane rows.
--
-- Every identifier here is an application-owned ID resolved by the authority
-- before a statement runs: the store never accepts an owner or organization
-- from a caller. One table per row kind, mirroring the resolution order the
-- effective-activation rule evaluates (project override, user default,
-- organization default, Claxedo default) plus the artifact pin that makes a
-- choice materializable.
--
-- `agent_plugin_revisions` is the per-organization concurrency and idempotency
-- record: mutations carry an expected revision and a derived operation ID, and
-- an exact retry of the same operation replays its revision instead of
-- bumping again.

create table agent_plugin_revisions (
  org_id text primary key references orgs (org_id) deferrable initially deferred,
  revision integer not null check (revision >= 0),
  last_operation_id text,
  last_operation_revision integer,
  updated_at integer not null,
  check ((last_operation_id is null) = (last_operation_revision is null))
);

-- Retained artifact per authority. `scope_key` is the derived partition the
-- point reads use so the three authorities share one primary key while keeping
-- their differing null shapes: `<org>:user:<user>`, `<org>:organization`, and
-- the global `claxedo`. The check below is what keeps that derivation honest.

create table agent_plugin_artifact_pins (
  scope_key text not null,
  plugin_instance_id text not null,
  authority text not null check (authority in ('user', 'organization', 'claxedo')),
  org_id text references orgs (org_id) deferrable initially deferred,
  owner_user_id text references users (user_id) deferrable initially deferred,
  artifact_digest text not null check (
    substr(artifact_digest, 1, 7) = 'sha256:'
    and length(artifact_digest) = 71
    and substr(artifact_digest, 8) not glob '*[^0-9a-f]*'
  ),
  source_id text not null,
  relative_path text not null,
  source_revision text not null,
  updated_at integer not null,
  primary key (scope_key, plugin_instance_id),
  check (
    (authority = 'user'
      and org_id is not null and owner_user_id is not null
      and scope_key = org_id || ':user:' || owner_user_id)
    or (authority = 'organization'
      and org_id is not null and owner_user_id is null
      and scope_key = org_id || ':organization')
    or (authority = 'claxedo'
      and org_id is null and owner_user_id is null
      and scope_key = 'claxedo')
  )
);

create index agent_plugin_artifact_pins_by_owner
  on agent_plugin_artifact_pins (org_id, authority, owner_user_id, plugin_instance_id);

-- A user's all-projects choice. `enabled = 0` is an explicit "off" that beats
-- the organization and Claxedo defaults; returning to default deletes the row.

create table agent_plugin_user_defaults (
  org_id text not null references orgs (org_id) deferrable initially deferred,
  owner_user_id text not null references users (user_id) deferrable initially deferred,
  plugin_instance_id text not null,
  harness_id text not null check (harness_id in ('opencode', 'claude', 'codex', 'cursor')),
  enabled integer not null check (enabled in (0, 1)),
  updated_at integer not null,
  primary key (org_id, owner_user_id, plugin_instance_id, harness_id)
);

create table agent_plugin_project_overrides (
  org_id text not null references orgs (org_id) deferrable initially deferred,
  owner_user_id text not null references users (user_id) deferrable initially deferred,
  project_id text not null references projects (project_id) deferrable initially deferred,
  plugin_instance_id text not null,
  harness_id text not null check (harness_id in ('opencode', 'claude', 'codex', 'cursor')),
  enabled integer not null check (enabled in (0, 1)),
  updated_at integer not null,
  primary key (org_id, owner_user_id, project_id, plugin_instance_id, harness_id)
);

-- Organization and Claxedo defaults carry no `enabled` column on purpose: the
-- authority above them can only turn a plugin on, and the absence of the row is
-- the only way it is off.

create table agent_plugin_organization_defaults (
  org_id text not null references orgs (org_id) deferrable initially deferred,
  plugin_instance_id text not null,
  harness_id text not null check (harness_id in ('opencode', 'claude', 'codex', 'cursor')),
  updated_at integer not null,
  primary key (org_id, plugin_instance_id, harness_id)
);

create table agent_plugin_claxedo_defaults (
  plugin_instance_id text not null,
  harness_id text not null check (harness_id in ('opencode', 'claude', 'codex', 'cursor')),
  updated_at integer not null,
  primary key (plugin_instance_id, harness_id)
);
