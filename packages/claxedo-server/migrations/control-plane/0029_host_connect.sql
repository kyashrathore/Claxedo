-- A machine enrolled by invitation has standing of its own: it signs every
-- request with its key (no account bearer on the box), so the enrollment row
-- carries what the verifier and the serving predicate need.
--
-- `key_version` is bumped by the account re-enroll upsert whenever the public
-- key changes; every machine-signed mutation asserts it inside its batch, so a
-- request verified against a key that was replaced in between writes nothing.
-- `serving_generation` orders live instances of one enrollment: a starting
-- instance acquires the next one and every earlier generation's beats and
-- tunnels are refused. The scope is the owner's grant — the roots the machine
-- may serve and who may see them — versioned so a host can tell a newer
-- delivery from a stale one. Existing rows are account enrollments.

alter table host_enrollments add column key_version integer not null default 1;

alter table host_enrollments add column serving_generation integer not null default 0;

alter table host_enrollments add column generation_acquired_at integer;

alter table host_enrollments add column enrolled_via text not null default 'account'
  check (enrolled_via in ('account', 'invitation'));

alter table host_enrollments add column scope_json text
  check (scope_json is null or json_valid(scope_json));

alter table host_enrollments add column scope_revision integer not null default 0;

-- Replay store for machine-signed requests. Insert-or-fail on the primary key
-- IS the consumption; rows expire at the request timestamp plus the nonce TTL
-- and are swept by exact expiry inside the heartbeat batch.
create table host_request_nonces (
  enrollment_id text not null,
  nonce text not null,
  expires_at integer not null,
  primary key (enrollment_id, nonce)
);

create index host_request_nonces_by_expiry
  on host_request_nonces (expires_at);

-- A description of an assignment is versioned per re-point. The revision is
-- bumped in the same batch that writes `workspaces.remote_directory`, so a
-- host never sees a new directory under an old revision.
alter table host_workspace_assignments add column revision integer not null default 1;

-- Readiness is state the heartbeat writes from the host's acks, not a minted
-- token. The one serving predicate reads it: a workspace routes only when the
-- readiness row names the assigned enrollment, its current serving generation
-- and the assignment's current revision, on a live lease.
create table host_assignment_readiness (
  workspace_id text primary key,
  enrollment_id text not null,
  generation integer not null,
  revision integer not null,
  ready_at integer not null
);

create index host_assignment_readiness_by_enrollment
  on host_assignment_readiness (enrollment_id);

-- A bearer invitation: `chx_inv_1.<invitation_id>.<secret>`. Only the secret's
-- hash is stored. Single use; the redeemed columns are what lets the same host
-- redeem again after a lost response and get its enrollment back.
create table host_invitations (
  invitation_id text primary key,
  owner_user_id text not null references users (user_id) deferrable initially deferred,
  owner_actor_id text not null references actors (actor_id) deferrable initially deferred,
  org_id text not null,
  secret_hash text not null,
  display_name text,
  scope_json text not null check (json_valid(scope_json)),
  expires_at integer not null,
  redeemed_at integer,
  redeemed_enrollment_id text,
  redeemed_host_id text,
  redeemed_public_key_fingerprint text,
  created_by_actor_id text not null references actors (actor_id) deferrable initially deferred,
  created_at integer not null,
  revoked_at integer
);

create index host_invitations_by_owner
  on host_invitations (owner_actor_id, created_at desc, invitation_id);

create index host_invitations_by_redeemed_enrollment
  on host_invitations (redeemed_enrollment_id);
