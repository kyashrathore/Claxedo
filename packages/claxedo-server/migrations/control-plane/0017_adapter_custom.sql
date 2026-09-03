-- Retire the previous identity-provider adapter value; rows written under it
-- are removed, not migrated. SQLite cannot ALTER a CHECK constraint, so both
-- tables carrying the old union are rebuilt against ('better-auth', 'custom').
--
--   auth_identities (from 0002): adapter check and primary key preserved; the
--     by-user index and the user-immutability trigger are re-created.
--   user_deployed_owner_bootstrap_claims (from 0008): consumed_adapter check
--     plus the consumption-consistency check and the immutability trigger
--     re-created unchanged apart from the narrowed union.
--
-- No table references auth_identities or the claims table by foreign key, so
-- the deletes below have no dependents to cascade.

-- Retired identity-provider value: drop the rows before the rebuild copies them
-- into a table whose CHECK no longer admits it.
delete from auth_identities where adapter = 'clerk';

delete from user_deployed_owner_bootstrap_claims where consumed_adapter = 'clerk';

create table auth_identities_next (
  adapter text not null check (adapter in ('better-auth', 'custom')),
  issuer text not null,
  subject text not null,
  user_id text not null references users (user_id) deferrable initially deferred,
  linked_at integer not null,
  unlinked_at integer,
  primary key (adapter, issuer, subject)
);

insert into auth_identities_next (adapter, issuer, subject, user_id, linked_at, unlinked_at)
  select adapter, issuer, subject, user_id, linked_at, unlinked_at from auth_identities;

drop trigger if exists auth_identities_user_immutable;

drop table auth_identities;

alter table auth_identities_next rename to auth_identities;

create index auth_identities_by_user
  on auth_identities (user_id, unlinked_at);

create trigger auth_identities_user_immutable
before update of user_id on auth_identities
when new.user_id != old.user_id
BEGIN
  select raise(abort, 'auth identity user is immutable');
end;

create table user_deployed_owner_bootstrap_claims_next (
  deployment_id text primary key,
  claim_hash text not null unique check (
    substr(claim_hash, 1, 7) = 'sha256:'
    and length(claim_hash) = 71
    and substr(claim_hash, 8) not glob '*[^0-9a-f]*'
  ),
  admitted_identity_hash text not null check (
    substr(admitted_identity_hash, 1, 7) = 'sha256:'
    and length(admitted_identity_hash) = 71
    and substr(admitted_identity_hash, 8) not glob '*[^0-9a-f]*'
  ),
  expires_at integer not null,
  consumed_at integer,
  consumed_adapter text check (consumed_adapter in ('better-auth', 'custom')),
  consumed_issuer text,
  consumed_subject text,
  created_at integer not null,
  check (
    (consumed_at is null and consumed_adapter is null and consumed_issuer is null and consumed_subject is null)
    or
    (consumed_at is not null and consumed_adapter is not null and consumed_issuer is not null and consumed_subject is not null)
  )
);

insert into user_deployed_owner_bootstrap_claims_next
  (deployment_id, claim_hash, admitted_identity_hash, expires_at, consumed_at, consumed_adapter, consumed_issuer, consumed_subject, created_at)
  select deployment_id, claim_hash, admitted_identity_hash, expires_at, consumed_at, consumed_adapter, consumed_issuer, consumed_subject, created_at
  from user_deployed_owner_bootstrap_claims;

drop trigger if exists user_deployed_owner_bootstrap_identity_immutable;

drop table user_deployed_owner_bootstrap_claims;

alter table user_deployed_owner_bootstrap_claims_next rename to user_deployed_owner_bootstrap_claims;

create trigger user_deployed_owner_bootstrap_identity_immutable
before update of consumed_adapter, consumed_issuer, consumed_subject on user_deployed_owner_bootstrap_claims
when old.consumed_at is not null and (
  new.consumed_adapter is not old.consumed_adapter
  or new.consumed_issuer is not old.consumed_issuer
  or new.consumed_subject is not old.consumed_subject
)
BEGIN
  select raise(abort, 'bootstrap owner identity is immutable');
end;
