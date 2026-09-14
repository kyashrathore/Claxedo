-- The scope PATCH decides which assignments to retire by comparing the stored
-- directory to the new roots as bytes. Rows written before every writer
-- normalized the directory may carry `.`, `..`, repeated or trailing
-- separators, so `/srv/allowed/../secret` would survive a tightening to
-- `/srv/allowed` and `/srv/app/` would be retired under `/srv/app`. Every
-- absolute POSIX directory of a user-hosted workspace is rewritten to the form
-- `normalizePosixDirectory` produces; a Windows path stays as given.
--
-- The walk consumes one segment per step from `rest` (which ends in a
-- sentinel `/`) into `acc`, the normalized prefix built so far; `..` drops
-- the last segment of `acc` by trimming its non-separator tail. Re-running
-- this over normalized rows is a no-op.
with recursive walk (workspace_id, rest, acc) as (
  select workspace_id, substr(remote_directory, 2) || '/', ''
  from workspaces
  where access = 'user-hosted' and remote_directory is not null and substr(remote_directory, 1, 1) = '/'
  union all
  select
    workspace_id,
    substr(rest, instr(rest, '/') + 1),
    case substr(rest, 1, instr(rest, '/') - 1)
      when '' then acc
      when '.' then acc
      when '..' then rtrim(rtrim(acc, replace(acc, '/', '')), '/')
      else acc || '/' || substr(rest, 1, instr(rest, '/') - 1)
    end
  from walk
  where rest <> ''
),
normalized (workspace_id, remote_directory) as (
  select workspace_id, case when acc = '' then '/' else acc end from walk where rest = ''
)
update workspaces set remote_directory = (
  select normalized.remote_directory from normalized where normalized.workspace_id = workspaces.workspace_id
)
where workspace_id in (
  select workspace_id from normalized where normalized.remote_directory <> workspaces.remote_directory
);
