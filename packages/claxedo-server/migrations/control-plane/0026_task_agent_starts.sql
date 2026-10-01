alter table task_presets add column agent_startable integer not null default 0;

alter table task_session_links add column started_from_session_id text;

alter table task_session_links add column started_from_workspace_id text;

alter table task_session_links add column placement text not null default 'local';

create index task_session_links_session_idx on task_session_links (scope_id, session_id);

alter table task_session_links add column started_by text not null default 'person' check (started_by in ('person', 'agent'));
