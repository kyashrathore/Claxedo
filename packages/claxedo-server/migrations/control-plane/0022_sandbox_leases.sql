-- Sandbox leases on D1.
--
-- `createSandboxManager` needs ONE durable row per workspace so that the
-- isolate which won the right to provision a sandbox can be told apart from
-- every isolate that lost. The hosted control plane builds a fresh manager per
-- request, so an in-memory lease map cannot serve this: the isolate that
-- returned `acquired: true` is gone before the driver finishes booting.
--
-- This table is the D1 twin of the local `claxedo_workspace_lease` SQLite table
-- (src/sandbox/stores/lease.sql.ts). It is a SEPARATE table rather than a
-- shared one because the two deployments never read each other's leases: a
-- local lease names a process on the operator's machine, a hosted lease names a
-- cloud VM. The columns are the `SandboxLeaseRow` contract
-- (packages/sandbox-manager/src/lease-types.ts) spelled exactly, so the row is
-- the same shape on both sides and `sandboxLeaseStatus` is the one conversion.
--
-- `epoch` is the concurrency control, not a version counter for humans. D1 has
-- no multi-statement transaction, so every write in the D1 store is a single
-- statement guarded by `where epoch = <the epoch that write observed>`; a
-- guarded write that changes zero rows means another isolate got there first.
-- That is why `epoch` is `not null` with no way to skip it.
--
-- The four `_json` columns carry the structured halves of the lease (labels,
-- checkpoint reference, persistence capabilities, restore status). They are
-- `check (json_valid(...))` when present so a malformed write fails at the
-- database rather than surfacing later as an unparseable lease; the store still
-- parses defensively, because a valid JSON scalar is not a valid lease field.
--
-- D1 applies each statement on its own, so the index statements below stand
-- independent of the table statement and of each other.
create table sandbox_leases (
  workspace_id text primary key,
  lease_id text not null,
  home_region text not null default 'us-east',
  epoch integer not null default 1,
  status text not null default 'pending',
  driver text not null,
  driver_resource_id text,
  driver_snapshot_id text,
  sandbox_id text,
  url text,
  retry_count integer not null default 0,
  next_retry_at integer,
  last_heartbeat_at integer,
  last_activity_at integer,
  last_health_failure_at integer,
  last_error text,
  compute_class text,
  accel_base_image_id text,
  accel_prepared_image_id text,
  accel_snapshot_id text,
  labels_json text check (labels_json is null or json_valid(labels_json)),
  checkpoint_json text check (checkpoint_json is null or json_valid(checkpoint_json)),
  persistence_json text check (persistence_json is null or json_valid(persistence_json)),
  restore_json text check (restore_json is null or json_valid(restore_json)),
  created_at integer not null,
  updated_at integer not null
);

create index sandbox_leases_by_status on sandbox_leases (status);

create index sandbox_leases_by_sandbox on sandbox_leases (sandbox_id);

create index sandbox_leases_by_updated on sandbox_leases (updated_at);
