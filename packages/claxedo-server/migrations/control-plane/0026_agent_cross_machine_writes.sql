-- "Agents may act on my other machines", one row per account.
--
-- Read when a cloud root's Tasks grant is minted: `start` is granted only to
-- an owner whose row holds 1, and an absent row answers the same as 0, so
-- nobody is opted in by never having visited Settings. No foreign key to
-- `users`: a preference must not be a reason a user row cannot be removed.

create table user_agent_settings (
  user_id text not null primary key,
  cross_machine_writes integer not null default 0 check (cross_machine_writes in (0, 1)),
  updated_at integer not null
);

-- Whether an agent inside a session may start this preset. Off for every
-- preset that exists, because no person has marked one yet.

alter table task_presets add column agent_startable integer not null default 0;

-- Which session's agent started a linked attempt, and where it runs. Every
-- link that exists was started by a person from the app, in the task's own
-- workspace, so the backfill is null and local.

alter table task_session_links add column started_from_session_id text;

alter table task_session_links add column started_from_workspace_id text;

alter table task_session_links add column placement text not null default 'local';

create index task_session_links_session_idx on task_session_links (scope_id, session_id);

-- Who asked for a linked attempt, apart from which session: a root's own
-- grant starts as an agent with no session to name.

alter table task_session_links add column started_by text not null default 'person' check (started_by in ('person', 'agent'));
