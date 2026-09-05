-- Hosted Connections on D1.
--
-- The hosted control plane builds a FRESH connections service per request, so
-- neither a connection row nor an OAuth attempt may live in isolate memory:
-- the isolate that answered `POST /:id/connect` is gone by the time
-- `GET /attempts/:state` runs. These two tables are the durable halves the
-- Connections kit's `ConnectionStorePort` and `Attempts` ports are adapted onto
-- (src/connections/hosted-d1/*).
--
-- No credential material lives here. A connection's access token is written to
-- the envelope-encrypted per-org credential store (`hostedOrgCredentials`);
-- `state`, `verifier`, and `device_code` are this flow's own per-attempt random
-- values, all dead within the 10-minute TTL and none authenticating anything on
-- its own.

-- Connection metadata, partitioned by (org, owner).
--
-- `owner_user_id` null IS the organization partition — the hosted routes run
-- with `ownerlessRows: "refuse"`, so the kit's owner-absent "deployment-wide
-- team" partition is unreachable and this column's null means exactly one
-- thing: the row belongs to `org:{org_id}` rather than to `user:{owner_user_id}`.
--
-- There is no `token_type` column: the wire form a credential is presented in
-- is a property of the INTEGRATION, not of the row, and the kit's token service
-- reads it from `decl.keyTokenType` (packages/claxedo-connections/src/tokens.ts).
-- A stored copy would be a second, drifting answer to the same question.
create table hosted_connections (
  connection_id text primary key,
  org_id text not null references orgs (org_id) deferrable initially deferred,
  owner_user_id text references users (user_id) deferrable initially deferred,
  integration_id text not null,
  granted_capabilities_json text not null check (json_valid(granted_capabilities_json)),
  fields_json text not null default '{}' check (json_valid(fields_json)),
  account_label text,
  created_at integer not null,
  updated_at integer not null
);

create index hosted_connections_by_partition
  on hosted_connections (org_id, owner_user_id, integration_id);

-- One row per integration per partition.
--
-- This is a real kit invariant, not a convenience: `createConnectionsService`
-- resolves an existing row with `connections.get(integrationId, owner)`,
-- refuses a second connect with `connection_exists` unless `confirmReplace`,
-- and REUSES the found row's id when replacing. A second row for the same
-- (org, owner, integration) is therefore unreachable through the service and
-- would be a silent duplicate whose credential (`integration:{connection_id}`)
-- no route could ever reach. The index makes that state impossible instead of
-- merely improbable. `coalesce` is needed because SQLite treats distinct nulls
-- as non-equal, which would exempt the organization partition from the rule.
create unique index hosted_connections_one_per_partition
  on hosted_connections (org_id, coalesce(owner_user_id, ''), integration_id);

-- Durable OAuth / device-grant attempts.
--
-- Semantics are the kit's in-memory store's, ported rather than reinvented so
-- both stores answer alike (packages/claxedo-connections/src/attempts.ts):
--
--   * `consume` is single-use and atomic — it flips `completing`, so a
--     concurrent poll cannot settle the same attempt twice;
--   * `peek` is the NON-consuming read device grants poll with, and it RECORDS
--     an expiry it observes;
--   * a pending row past its TTL is not consumable and reads as `expired`;
--   * a MID-CONSUME row (`completing = 1`) is left pending past its TTL: only
--     `settle` may move it, so a slow token exchange still reports its real
--     outcome instead of a spurious "expired";
--   * `expire` is distinct from `settle(false)` — only the former is worth
--     restarting, and the two carry different copy.
--
-- `expires_at` carries two meanings by status, exactly as the Convex table it
-- replaces did: for a pending row it is the TTL deadline, and for a terminal
-- row it is the end of the retention window after which the sweep deletes it.
create table hosted_connection_attempts (
  state text primary key,
  verifier text not null,
  integration_id text not null,
  device_code text,
  owner text,
  scope text not null check (scope in ('team', 'personal')),
  context_json text check (context_json is null or json_valid(context_json)),
  routing_json text check (routing_json is null or json_valid(routing_json)),
  status text not null check (status in ('pending', 'complete', 'failed', 'expired')),
  completing integer not null default 0 check (completing in (0, 1)),
  message text,
  expires_at integer not null,
  created_at integer not null,
  updated_at integer not null
);

-- The sweep reads by (status, expires_at) so its read set is bounded by
-- expired rows rather than by table size.
create index hosted_connection_attempts_by_status_expiry
  on hosted_connection_attempts (status, expires_at);
