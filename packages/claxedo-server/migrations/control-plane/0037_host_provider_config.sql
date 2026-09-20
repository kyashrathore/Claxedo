-- The owner's provider configuration for one machine, stored only as the
-- ciphertext sealed to the ECDH key that machine declared on its beat; the
-- control plane holds no key that opens it. `provider_config_revision` moves
-- on every push, a withdrawal included (a revision whose blob is null), and
-- the beat restates the row until `provider_config_acked_revision` catches up,
-- so a machine that was offline learns of a push or a withdrawal on its next
-- beat. Both counters start at 0: never pushed, and nothing held.

alter table host_enrollments add column sealing_public_key_json text
  check (sealing_public_key_json is null or json_valid(sealing_public_key_json));

alter table host_enrollments add column provider_config_sealed text;

alter table host_enrollments add column provider_config_revision integer not null default 0;

alter table host_enrollments add column provider_config_acked_revision integer not null default 0;

alter table host_enrollments add column provider_config_updated_at integer;

-- The key the stored blob was sealed to, and the provider ids inside it. A
-- machine replaces its sealing key by declaring a new one on a beat, which
-- leaves the stored blob openable by nobody; comparing the two columns is how
-- the beat stops restating a dead payload and how the owner is told to push
-- again. The ids are the one thing about the plaintext the control plane may
-- keep: the route already validated and audited them, and a panel that cannot
-- name what a machine holds cannot warn that a push replaces the whole set.

alter table host_enrollments add column provider_config_sealed_key_json text
  check (provider_config_sealed_key_json is null or json_valid(provider_config_sealed_key_json));

alter table host_enrollments add column provider_config_provider_ids text
  check (provider_config_provider_ids is null or json_valid(provider_config_provider_ids));
