-- Which generation of the sender-identity contract a binding was written
-- under. 0 is every row that already existed: the producer that wrote it
-- accepted whatever string a transport called a sender id, so a row keyed
-- `telegram:12345` may record the handle @12345 rather than account 12345, and
-- the two are different people. Prefixing or re-encoding the stored strings
-- cannot separate them, because a legacy display name can carry any shape a
-- new key has. 1 is a binding written after the transports were proven to
-- carry the platform's stable account id.
--
-- Only version 1 authorizes. Version 0 rows stay as operator-inspectable
-- history and are never promoted: re-admitting one of those senders means
-- pairing again or claiming the id from the signed account that owns it. The
-- CHECK and the insert guard below are what keep a later writer from minting a
-- version 0 row, so "legacy" stays a closed set fixed at this migration.

alter table channel_identity_bindings add column identity_version integer not null default 0
  check (identity_version in (0, 1));

-- The active-binding uniqueness now holds among current rows only. Left on all
-- unrevoked rows it would hand a legacy row a veto over the account that
-- actually owns the id: the insert would collide and the real owner could
-- never bind, which is a denial of the reapproval path the boundary depends
-- on.
drop index if exists channel_identity_bindings_active_external;

create unique index if not exists channel_identity_bindings_active_external
  on channel_identity_bindings (deployment_id, channel, external_user_id)
  where revoked_at is null and identity_version = 1;

create index if not exists channel_identity_bindings_legacy_external
  on channel_identity_bindings (deployment_id, channel, external_user_id)
  where identity_version = 0;

drop trigger if exists channel_identity_binding_intent_immutable;

create trigger channel_identity_binding_intent_immutable
before update of deployment_id, channel, external_user_id, user_id, actor_id,
  bound_by_actor_id, created_at, identity_version
on channel_identity_bindings
when new.deployment_id != old.deployment_id
  or new.channel != old.channel
  or new.external_user_id != old.external_user_id
  or new.user_id != old.user_id
  or new.actor_id != old.actor_id
  or new.bound_by_actor_id != old.bound_by_actor_id
  or new.created_at != old.created_at
  or new.identity_version != old.identity_version
BEGIN
  select raise(abort, 'channel identity binding intent is immutable');
end;

create trigger if not exists channel_identity_binding_version_current
before insert on channel_identity_bindings
when new.identity_version != 1
BEGIN
  select raise(abort, 'channel identity binding must be written at the current identity version');
end;
