-- The highest assignment revision ever issued for the workspace. Every
-- assignment insert or upsert takes the next value and moves this counter in
-- the same batch, so an unassign followed by a reassign, a directory re-point
-- or a move to another host never repeats a revision a machine may still be
-- acking. A workspace that already carries an assignment starts at that
-- assignment's revision so the next one is strictly greater. The backfill
-- only ever raises the counter: run again once the counter has moved past
-- the live assignment's revision, it leaves the counter where it is.
alter table workspaces add column host_assignment_revision integer not null default 0;

update workspaces set host_assignment_revision = max(host_assignment_revision, (
  select assignment.revision from host_workspace_assignments assignment
  where assignment.workspace_id = workspaces.workspace_id
))
where exists (
  select 1 from host_workspace_assignments assignment
  where assignment.workspace_id = workspaces.workspace_id
);
