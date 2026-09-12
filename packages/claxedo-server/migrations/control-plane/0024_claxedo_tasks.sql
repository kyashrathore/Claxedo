-- Tasks and personal execution presets, partitioned by organization.
--
-- `scope_id` is the org id the workspace authority resolved for the signed
-- caller before any statement runs, and `owner_id` is that caller's token
-- subject. Neither is ever taken from a request body, and every predicate in
-- the store names `scope_id`, so a row belonging to another organization is
-- unreachable rather than filtered out afterwards.
--
-- Deliberately no foreign keys to `orgs` or `users`: this feature stores no
-- authority facts, and a reference would make its tables a reason a tenant row
-- cannot be removed. The column names match the desktop-local SQLite schema
-- (`claxedo_task*`) exactly, because one decoder reads the rows of both.

create table task_presets (
  scope_id text not null,
  preset_id text not null,
  revision integer not null,
  owner_id text not null,
  name text not null,
  instructions text not null,
  execution text not null,
  configurations text not null,
  archived_at integer,
  created_at integer not null,
  updated_at integer not null,
  primary key (scope_id, preset_id)
);

create index task_presets_page_idx on task_presets (scope_id, owner_id, created_at, preset_id);

create table tasks (
  scope_id text not null,
  task_id text not null,
  revision integer not null,
  project_id text not null,
  workspace_id text,
  parent_task_id text,
  title text not null,
  description text not null,
  status text not null,
  child_set_revision integer not null,
  archived_at integer,
  created_at integer not null,
  updated_at integer not null,
  primary key (scope_id, task_id)
);

create index tasks_project_page_idx on tasks (scope_id, project_id, created_at, task_id);

create index tasks_child_page_idx on tasks (scope_id, parent_task_id, created_at, task_id);

-- One row per started attempt. The key is the origin the kit reserves, so two
-- clients racing the same (task, slot, attempt) collide here instead of each
-- acquiring its own session for one slot.

create table task_session_links (
  scope_id text not null,
  task_id text not null,
  slot text not null,
  attempt integer not null,
  session_id text not null,
  session_workspace_id text,
  continued_from_session_id text,
  continued_from_workspace_id text,
  preset_id text not null,
  preset_revision integer not null,
  preset_name_at_start text not null,
  configuration_digest text not null,
  handoff_text text,
  created_at integer not null,
  primary key (scope_id, task_id, slot, attempt)
);

create table task_command_receipts (
  scope_id text not null,
  client_request_id text not null,
  command_name text not null,
  request_hash text not null,
  result text not null,
  created_at integer not null,
  primary key (scope_id, client_request_id)
);

-- D1 has no interactive transaction: a unit of work is read first and then
-- committed as one `batch`, so a revision the unit read could have moved by
-- the time the batch runs. Each guarded write is preceded in the same batch by
-- an insert here that selects nothing while the predicate still holds -- and
-- inserts the reason it stopped holding when it does not. The check refuses
-- every row on purpose: the refusal is what rolls the batch back, so this
-- table is always empty.

create table task_write_guards (
  refusal text not null,
  check (false)
);
