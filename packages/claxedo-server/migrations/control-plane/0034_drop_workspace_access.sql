-- `access` carried nothing `backing` did not. The only insert into `workspaces`
-- refused any pair but `cloud-vm`/`cloud` and `local-worktree`/`user-hosted`,
-- and no statement ever updated either column, so the two could not drift.
-- Where a workspace runs is now the placement: `backing` says whether the
-- provisioner owns the machine, and `host_workspace_assignments` names the
-- enrolled machine when it does not.
--
-- No index, trigger or earlier migration references the column.
alter table workspaces drop column access;
