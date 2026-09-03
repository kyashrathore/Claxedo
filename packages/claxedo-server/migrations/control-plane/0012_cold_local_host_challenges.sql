drop trigger host_challenge_intent_immutable;

drop index host_attestation_challenges_by_expiry;

alter table host_attestation_challenges rename to host_attestation_challenges_scoped;

create table host_attestation_challenges (
  challenge_id text primary key,
  workspace_id text not null,
  owner_user_id text not null references users (user_id) deferrable initially deferred,
  owner_actor_id text not null references actors (actor_id) deferrable initially deferred,
  host_id text not null,
  nonce text not null unique,
  expires_at integer not null,
  used_at integer,
  used_signature_hash text,
  created_at integer not null
);

insert into host_attestation_challenges (
  challenge_id, workspace_id, owner_user_id, owner_actor_id, host_id, nonce,
  expires_at, used_at, used_signature_hash, created_at
)
select challenge_id, workspace_id, owner_user_id, owner_actor_id, host_id, nonce,
  expires_at, used_at, used_signature_hash, created_at
from host_attestation_challenges_scoped;

drop table host_attestation_challenges_scoped;

create index host_attestation_challenges_by_expiry
  on host_attestation_challenges (expires_at, used_at, challenge_id);

create trigger host_challenge_intent_immutable
before update of workspace_id, owner_user_id, owner_actor_id, host_id, nonce, expires_at, created_at
on host_attestation_challenges
when new.workspace_id != old.workspace_id
  or new.owner_user_id != old.owner_user_id or new.owner_actor_id != old.owner_actor_id
  or new.host_id != old.host_id or new.nonce != old.nonce
  or new.expires_at != old.expires_at or new.created_at != old.created_at
BEGIN
  select raise(abort, 'host challenge intent is immutable');
end;
