-- Images attached to a task at create, one per row with the bytes inline.
--
-- The kit caps an image at 1,572,864 decoded bytes so the row stays under
-- D1's 2,000,000-byte row limit beside its key and name; there is no second
-- store (R2 or otherwise) to keep in step with the task's transaction.
-- Column names match `claxedo_task_attachment` in the desktop-local SQLite
-- schema, as every Tasks table here does, because one decoder reads both.

create table task_attachments (
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

create index task_attachments_task_idx on task_attachments (scope_id, task_id, position);
