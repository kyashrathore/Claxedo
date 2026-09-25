-- The session list is read a keyset page at a time, in the list's order:
-- last human turn, then creation. A machine publishes each of its sessions'
-- list rows (title, turn times, status, archive), never a transcript; status
-- is the last one the machine reported, stamped with when it reported it.

alter table sessions add column archived_at integer;

alter table sessions add column status text check (status is null or status in ('idle', 'busy', 'retry', 'recovering'));

alter table sessions add column status_at integer;

alter table sessions add column awaiting_input integer not null default 0 check (awaiting_input in (0, 1));

create index sessions_by_project_human_turn
  on sessions (project_id, deleted_at, archived_at, last_human_turn_at, created_at);

create index sessions_by_workspace_human_turn
  on sessions (workspace_id, deleted_at, archived_at, last_human_turn_at, created_at);
