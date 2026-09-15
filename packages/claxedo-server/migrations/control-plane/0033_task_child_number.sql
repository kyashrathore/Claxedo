-- A subtask is filed under its parent's number with a child number of its own
-- (`20.1`), so the unique index widens to the pair. Existing subtasks held a
-- project number of their own; each takes its parent's, and its place among
-- the parent's children by creation order becomes its child number. The index
-- is dropped first because a child's new pair can equal a root's old number
-- until every row is rewritten. Zero on a root rather than null, because a
-- unique index treats every null as distinct.

alter table tasks add column child_number integer not null default 0;

drop index tasks_number_idx;

update tasks set child_number = (
  select count(*) from tasks as sibling
  where sibling.scope_id = tasks.scope_id
    and sibling.parent_task_id = tasks.parent_task_id
    and (sibling.created_at < tasks.created_at
      or (sibling.created_at = tasks.created_at and sibling.task_id <= tasks.task_id))
) where parent_task_id is not null;

update tasks set number = (
  select parent.number from tasks as parent
  where parent.scope_id = tasks.scope_id and parent.task_id = tasks.parent_task_id
) where parent_task_id is not null;

create unique index tasks_number_idx on tasks (scope_id, project_id, number, child_number);
