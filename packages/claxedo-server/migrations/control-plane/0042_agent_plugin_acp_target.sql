-- Custom ACP agents are an Agent Plugins target. SQLite cannot widen a check
-- constraint in place, and nothing released holds activation rows, so the four
-- activation tables are recreated with the wider harness set.

drop table agent_plugin_user_defaults;
drop table agent_plugin_project_overrides;
drop table agent_plugin_organization_defaults;
drop table agent_plugin_claxedo_defaults;

create table agent_plugin_user_defaults (
  org_id text not null references orgs (org_id) deferrable initially deferred,
  owner_user_id text not null references users (user_id) deferrable initially deferred,
  plugin_instance_id text not null,
  harness_id text not null check (harness_id in ('opencode', 'claude', 'codex', 'cursor', 'acp')),
  enabled integer not null check (enabled in (0, 1)),
  updated_at integer not null,
  primary key (org_id, owner_user_id, plugin_instance_id, harness_id)
);

create table agent_plugin_project_overrides (
  org_id text not null references orgs (org_id) deferrable initially deferred,
  owner_user_id text not null references users (user_id) deferrable initially deferred,
  project_id text not null references projects (project_id) deferrable initially deferred,
  plugin_instance_id text not null,
  harness_id text not null check (harness_id in ('opencode', 'claude', 'codex', 'cursor', 'acp')),
  enabled integer not null check (enabled in (0, 1)),
  updated_at integer not null,
  primary key (org_id, owner_user_id, project_id, plugin_instance_id, harness_id)
);

create table agent_plugin_organization_defaults (
  org_id text not null references orgs (org_id) deferrable initially deferred,
  plugin_instance_id text not null,
  harness_id text not null check (harness_id in ('opencode', 'claude', 'codex', 'cursor', 'acp')),
  updated_at integer not null,
  primary key (org_id, plugin_instance_id, harness_id)
);

create table agent_plugin_claxedo_defaults (
  plugin_instance_id text not null,
  harness_id text not null check (harness_id in ('opencode', 'claude', 'codex', 'cursor', 'acp')),
  updated_at integer not null,
  primary key (plugin_instance_id, harness_id)
);
