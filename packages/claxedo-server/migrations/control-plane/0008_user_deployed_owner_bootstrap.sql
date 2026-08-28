-- One-use deployment-owner bootstrap. The plaintext claim is never persisted;
-- deployment tooling registers only its SHA-256 identity and an expiry.

create table user_deployed_owner_bootstrap_claims (
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
  consumed_adapter text check (consumed_adapter in ('better-auth', 'clerk')),
  consumed_issuer text,
  consumed_subject text,
  created_at integer not null,
  check (
    (consumed_at is null and consumed_adapter is null and consumed_issuer is null and consumed_subject is null)
    or
    (consumed_at is not null and consumed_adapter is not null and consumed_issuer is not null and consumed_subject is not null)
  )
);

create trigger user_deployed_owner_bootstrap_identity_immutable
before update of consumed_adapter, consumed_issuer, consumed_subject on user_deployed_owner_bootstrap_claims
when old.consumed_at is not null and (
  new.consumed_adapter is not old.consumed_adapter
  or new.consumed_issuer is not old.consumed_issuer
  or new.consumed_subject is not old.consumed_subject
)
begin
  select raise(abort, 'bootstrap owner identity is immutable');
end;
