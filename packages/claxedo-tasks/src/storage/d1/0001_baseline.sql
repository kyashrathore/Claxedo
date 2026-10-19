CREATE TABLE task_attachments (
  scope_id text not null,
  task_id text not null,
  attachment_id text not null,
  position integer not null,
  filename text not null,
  mime text not null,
  size integer not null,
  bytes blob not null,
  created_at integer not null,
  primary key (scope_id, task_id, attachment_id)
);

CREATE TABLE task_command_receipts (
  scope_id text not null,
  client_request_id text not null,
  command_name text not null,
  request_hash text not null,
  result text not null,
  created_at integer not null,
  primary key (scope_id, client_request_id)
);

CREATE TABLE task_presets (
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
  updated_at integer not null, agent_startable integer not null default 0,
  primary key (scope_id, preset_id)
);

CREATE TABLE task_session_links (
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
  created_at integer not null, started_from_session_id text, started_from_workspace_id text, placement text not null default 'local', started_by text not null default 'person' check (started_by in ('person', 'agent')),
  primary key (scope_id, task_id, slot, attempt)
);

CREATE TABLE task_write_guards (
  refusal text not null,
  check (false)
);

CREATE TABLE tasks (
  scope_id text not null,
  task_id text not null,
  revision integer not null,
  project_id text not null,
  number integer not null,
  workspace_id text,
  parent_task_id text,
  created_from_session_id text,
  created_from_workspace_id text,
  title text not null,
  description text not null,
  status text not null,
  child_set_revision integer not null,
  archived_at integer,
  created_at integer not null,
  updated_at integer not null, child_number integer not null default 0,
  primary key (scope_id, task_id)
);

CREATE INDEX task_attachments_task_idx on task_attachments (scope_id, task_id, position);

CREATE INDEX task_presets_page_idx on task_presets (scope_id, owner_id, created_at, preset_id);

CREATE INDEX task_session_links_session_idx on task_session_links (scope_id, session_id);

CREATE INDEX tasks_child_page_idx on tasks (scope_id, parent_task_id, created_at, task_id);

CREATE UNIQUE INDEX tasks_number_idx on tasks (scope_id, project_id, number, child_number);

CREATE INDEX tasks_project_page_idx on tasks (scope_id, project_id, created_at, task_id);
