-- Machine-wide enrollment consolidation (docs/plans/2026-09-01-148):
-- sharing becomes an OWNER-authenticated assignment of a workspace to one
-- enrolled host. An assignment carries no liveness of its own — the
-- enrollment lease answers "is the machine here", and the machine's consent
-- set (which workspaces it actually serves) is acked by the enrollment
-- heartbeat's v2 signature and stored on the enrollment row. Routing requires
-- assignment AND ack AND a live lease.
--
-- One workspace, one host: a local association id names a directory on ONE
-- machine, so workspace_id alone is the key. The retired local_host_links
-- table was unique on (workspace_id, host_id) and quietly allowed several
-- hosts to claim one workspace with arbitrary routing between them; that
-- ambiguity does not carry over.

create table host_workspace_assignments (
  workspace_id text primary key,
  host_id text not null,
  org_id text not null,
  owner_user_id text not null references users (user_id) deferrable initially deferred,
  owner_actor_id text not null references actors (actor_id) deferrable initially deferred,
  second_device_open_at integer,
  assigned_at integer not null,
  updated_at integer not null
);

create index host_workspace_assignments_by_host
  on host_workspace_assignments (host_id);

-- The machine's last-acked served set, written only by a verified heartbeat.
alter table host_enrollments add column acked_workspace_ids text;
alter table host_enrollments add column acked_at integer;
