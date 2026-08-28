-- Canonical workspace shares, machine enrollment, local host attestation, and
-- runtime-token revocation. Provider subjects never enter these tables.

alter table workspace_memberships rename to workspace_direct_memberships;
drop index workspace_memberships_by_user;
create index workspace_direct_memberships_by_user
  on workspace_direct_memberships (user_id, revoked_at, workspace_id);

create table workspace_share_grants (
  grant_id text primary key,
  workspace_id text not null,
  org_id text not null,
  project_id text not null,
  target_kind text not null check (target_kind in ('actor', 'user', 'org')),
  target_actor_id text references actors (actor_id) deferrable initially deferred,
  target_user_id text references users (user_id) deferrable initially deferred,
  target_org_id text references orgs (org_id) deferrable initially deferred,
  role text not null check (role in ('viewer', 'editor', 'admin')),
  created_by_actor_id text not null references actors (actor_id) deferrable initially deferred,
  created_at integer not null,
  revoked_at integer,
  foreign key (workspace_id, org_id, project_id)
    references workspaces (workspace_id, org_id, project_id) deferrable initially deferred,
  check (
    (target_kind = 'actor' and target_actor_id is not null and target_user_id is null and target_org_id is null)
    or (target_kind = 'user' and target_actor_id is null and target_user_id is not null and target_org_id is null)
    or (target_kind = 'org' and target_actor_id is null and target_user_id is null and target_org_id is not null)
  )
);

create unique index workspace_share_grants_active_actor
  on workspace_share_grants (workspace_id, target_actor_id)
  where target_kind = 'actor' and revoked_at is null;

create unique index workspace_share_grants_active_user
  on workspace_share_grants (workspace_id, target_user_id)
  where target_kind = 'user' and revoked_at is null;

create unique index workspace_share_grants_active_org
  on workspace_share_grants (workspace_id, target_org_id)
  where target_kind = 'org' and revoked_at is null;

create trigger workspace_share_target_scope
before insert on workspace_share_grants
when not (
  (new.target_kind = 'org' and new.target_org_id = new.org_id)
  or (new.target_kind = 'user' and exists (
    select 1 from org_memberships membership
    where membership.org_id = new.org_id and membership.user_id = new.target_user_id
      and membership.revoked_at is null
  ))
  or (new.target_kind = 'actor' and exists (
    select 1 from actors actor
    join org_memberships membership
      on membership.user_id = actor.user_id and membership.org_id = new.org_id and membership.revoked_at is null
    where actor.actor_id = new.target_actor_id and actor.state = 'active'
  ))
)
begin
  select raise(abort, 'workspace share target belongs to another tenant');
end;

create trigger workspace_share_intent_immutable
before update of workspace_id, org_id, project_id, target_kind, target_actor_id,
  target_user_id, target_org_id, role, created_by_actor_id, created_at
on workspace_share_grants
when new.workspace_id != old.workspace_id
  or new.org_id != old.org_id
  or new.project_id != old.project_id
  or new.target_kind != old.target_kind
  or new.target_actor_id is not old.target_actor_id
  or new.target_user_id is not old.target_user_id
  or new.target_org_id is not old.target_org_id
  or new.role != old.role
  or new.created_by_actor_id != old.created_by_actor_id
  or new.created_at != old.created_at
begin
  select raise(abort, 'workspace share intent is immutable');
end;

-- Existing authority SQL continues to read `workspace_memberships`. The view
-- makes active grants part of that one decision without copying grant state
-- into rows that could survive revocation or tenant removal.
create view workspace_memberships as
with candidates as (
  select workspace_id, user_id, role, created_at, updated_at
  from workspace_direct_memberships
  where revoked_at is null
  union all
  select grant.workspace_id, grant.target_user_id, grant.role, grant.created_at, grant.created_at
  from workspace_share_grants grant
  join org_memberships membership
    on membership.org_id = grant.org_id and membership.user_id = grant.target_user_id
    and membership.revoked_at is null
  where grant.target_kind = 'user' and grant.revoked_at is null
  union all
  select grant.workspace_id, actor.user_id, grant.role, grant.created_at, grant.created_at
  from workspace_share_grants grant
  join actors actor
    on actor.actor_id = grant.target_actor_id and actor.state = 'active' and actor.user_id is not null
  join org_memberships membership
    on membership.org_id = grant.org_id and membership.user_id = actor.user_id
    and membership.revoked_at is null
  where grant.target_kind = 'actor' and grant.revoked_at is null
  union all
  select grant.workspace_id, membership.user_id, grant.role, grant.created_at, grant.created_at
  from workspace_share_grants grant
  join org_memberships membership
    on membership.org_id = grant.target_org_id and membership.revoked_at is null
  where grant.target_kind = 'org' and grant.revoked_at is null
), ranked as (
  select workspace_id, user_id, max(
    case role when 'viewer' then 1 when 'editor' then 2 when 'admin' then 3 when 'owner' then 4 end
  ) as role_rank, min(created_at) as created_at, max(updated_at) as updated_at
  from candidates
  group by workspace_id, user_id
)
select workspace_id, user_id,
  case role_rank when 1 then 'viewer' when 2 then 'editor' when 3 then 'admin' else 'owner' end as role,
  created_at, updated_at, null as revoked_at
from ranked;

create trigger workspace_memberships_insert
instead of insert on workspace_memberships
begin
  insert into workspace_direct_memberships (
    workspace_id, user_id, role, created_at, updated_at, revoked_at
  ) values (new.workspace_id, new.user_id, new.role, new.created_at, new.updated_at, new.revoked_at)
  on conflict (workspace_id, user_id) do update set
    role = excluded.role, updated_at = excluded.updated_at, revoked_at = excluded.revoked_at;
end;

create trigger workspace_memberships_update
instead of update on workspace_memberships
begin
  update workspace_direct_memberships set
    role = new.role, updated_at = new.updated_at, revoked_at = new.revoked_at
  where workspace_id = old.workspace_id and user_id = old.user_id;
end;

create trigger workspace_memberships_delete
instead of delete on workspace_memberships
begin
  delete from workspace_direct_memberships
  where workspace_id = old.workspace_id and user_id = old.user_id;
end;

create table host_attestation_challenges (
  challenge_id text primary key,
  workspace_id text not null,
  org_id text not null,
  project_id text not null,
  owner_user_id text not null references users (user_id) deferrable initially deferred,
  owner_actor_id text not null references actors (actor_id) deferrable initially deferred,
  host_id text not null,
  nonce text not null unique,
  expires_at integer not null,
  used_at integer,
  used_signature_hash text,
  created_at integer not null,
  foreign key (workspace_id, org_id, project_id)
    references workspaces (workspace_id, org_id, project_id) deferrable initially deferred
);

create index host_attestation_challenges_by_expiry
  on host_attestation_challenges (expires_at, used_at, challenge_id);

create table local_host_links (
  workspace_id text not null,
  org_id text not null,
  project_id text not null,
  host_id text not null,
  owner_user_id text not null references users (user_id) deferrable initially deferred,
  owner_actor_id text not null references actors (actor_id) deferrable initially deferred,
  public_key_json text not null check (json_valid(public_key_json)),
  display_name text,
  last_seen_at integer not null,
  expires_at integer not null,
  paused_at integer,
  revoked_at integer,
  second_device_open_at integer,
  last_signature_hash text,
  created_at integer not null,
  updated_at integer not null,
  primary key (workspace_id, host_id),
  foreign key (workspace_id, org_id, project_id)
    references workspaces (workspace_id, org_id, project_id) deferrable initially deferred
);

create index local_host_links_by_workspace_activity
  on local_host_links (workspace_id, revoked_at, paused_at, expires_at, last_seen_at desc);

create table host_enrollment_requests (
  request_id text primary key,
  owner_user_id text not null references users (user_id) deferrable initially deferred,
  owner_actor_id text not null references actors (actor_id) deferrable initially deferred,
  host_id text not null,
  nonce text not null unique,
  expires_at integer not null,
  used_at integer,
  used_signature_hash text,
  created_at integer not null
);

create index host_enrollment_requests_by_expiry
  on host_enrollment_requests (expires_at, used_at, request_id);

create table host_enrollments (
  enrollment_id text primary key,
  owner_user_id text not null references users (user_id) deferrable initially deferred,
  owner_actor_id text not null references actors (actor_id) deferrable initially deferred,
  host_id text not null,
  public_key_json text not null check (json_valid(public_key_json)),
  display_name text,
  last_seen_at integer not null,
  expires_at integer not null,
  paused_at integer,
  revoked_at integer,
  last_signature_hash text,
  created_at integer not null,
  updated_at integer not null,
  unique (owner_actor_id, host_id)
);

create index host_enrollments_by_owner_activity
  on host_enrollments (owner_actor_id, last_seen_at desc, enrollment_id);

create table host_signature_uses (
  signature_hash text primary key,
  signature_domain text not null check (
    signature_domain in ('local-register', 'local-heartbeat', 'host-enroll', 'host-heartbeat')
  ),
  actor_id text not null references actors (actor_id) deferrable initially deferred,
  workspace_id text,
  host_id text not null,
  used_at integer not null
);

create table runtime_access_tokens (
  jti text primary key,
  workspace_id text not null,
  org_id text not null,
  project_id text not null,
  host_id text not null,
  minted_for_user_id text not null references users (user_id) deferrable initially deferred,
  minted_for_actor_id text not null references actors (actor_id) deferrable initially deferred,
  expires_at integer not null,
  revoked_at integer,
  created_at integer not null,
  foreign key (workspace_id, org_id, project_id)
    references workspaces (workspace_id, org_id, project_id) deferrable initially deferred
);

create index runtime_access_tokens_by_workspace_user
  on runtime_access_tokens (workspace_id, minted_for_user_id, revoked_at, expires_at);

create index runtime_access_tokens_by_workspace_host
  on runtime_access_tokens (workspace_id, host_id, revoked_at, expires_at);

create index runtime_access_tokens_by_actor_host
  on runtime_access_tokens (minted_for_actor_id, host_id, revoked_at, expires_at);

create trigger host_challenge_intent_immutable
before update of workspace_id, org_id, project_id, owner_user_id, owner_actor_id,
  host_id, nonce, expires_at, created_at
on host_attestation_challenges
when new.workspace_id != old.workspace_id or new.org_id != old.org_id or new.project_id != old.project_id
  or new.owner_user_id != old.owner_user_id or new.owner_actor_id != old.owner_actor_id
  or new.host_id != old.host_id or new.nonce != old.nonce
  or new.expires_at != old.expires_at or new.created_at != old.created_at
begin
  select raise(abort, 'host challenge intent is immutable');
end;

create trigger local_host_link_scope_immutable
before update of workspace_id, org_id, project_id, host_id, owner_user_id, owner_actor_id, created_at
on local_host_links
when new.workspace_id != old.workspace_id or new.org_id != old.org_id or new.project_id != old.project_id
  or new.host_id != old.host_id or new.owner_user_id != old.owner_user_id
  or new.owner_actor_id != old.owner_actor_id or new.created_at != old.created_at
begin
  select raise(abort, 'local host link scope is immutable');
end;

create trigger host_enrollment_request_intent_immutable
before update of owner_user_id, owner_actor_id, host_id, nonce, created_at
on host_enrollment_requests
when new.owner_user_id != old.owner_user_id or new.owner_actor_id != old.owner_actor_id
  or new.host_id != old.host_id or new.nonce != old.nonce or new.created_at != old.created_at
begin
  select raise(abort, 'host enrollment request intent is immutable');
end;

create trigger host_enrollment_scope_immutable
before update of enrollment_id, owner_user_id, owner_actor_id, host_id, created_at
on host_enrollments
when new.enrollment_id != old.enrollment_id or new.owner_user_id != old.owner_user_id
  or new.owner_actor_id != old.owner_actor_id or new.host_id != old.host_id
  or new.created_at != old.created_at
begin
  select raise(abort, 'host enrollment scope is immutable');
end;

create trigger runtime_access_token_intent_immutable
before update of jti, workspace_id, org_id, project_id, host_id,
  minted_for_user_id, minted_for_actor_id, expires_at, created_at
on runtime_access_tokens
when new.jti != old.jti or new.workspace_id != old.workspace_id
  or new.org_id != old.org_id or new.project_id != old.project_id
  or new.host_id != old.host_id or new.minted_for_user_id != old.minted_for_user_id
  or new.minted_for_actor_id != old.minted_for_actor_id
  or new.expires_at != old.expires_at or new.created_at != old.created_at
begin
  select raise(abort, 'runtime access token intent is immutable');
end;
