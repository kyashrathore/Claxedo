-- Agent Plugin marketplaces a signed user or an organization registered.
--
-- The catalog used to read one hard-wired public collection. A registered
-- source is the same kind of fact as an artifact pin: application-owned IDs
-- resolved by the authority before any statement runs, never an owner or
-- organization supplied by a caller.
--
-- `scope_key` is the derived partition every point read uses, spelled exactly
-- as `agent_plugin_artifact_pins` spells it (0019): `<org>:user:<user>` for a
-- personal source and `<org>:organization` for one the whole organization
-- reads. It exists because the two row kinds differ in their null shape --
-- `owner_user_id` is null for an organization source -- and SQLite does not
-- enforce uniqueness across a nullable primary-key column, so a composite key
-- over `owner_user_id` would silently allow two identical organization rows.
-- The check below is what keeps the derivation honest.
--
-- `id` is the catalog provider id (`github:<owner>/<repo>@<ref>`), stable
-- because a retained artifact pin records `source_id`: a derived id that
-- changed shape would orphan every plugin retained from that source. Two users
-- in one organization may each register the same repository personally, so the
-- id is unique per scope rather than per organization; the catalog composition
-- keeps the organization row when a user sees both.

create table agent_plugin_sources (
  scope_key text not null,
  id text not null,
  org_id text not null references orgs (org_id) deferrable initially deferred,
  owner_user_id text references users (user_id) deferrable initially deferred,
  authority text not null check (authority in ('user', 'organization')),
  owner text not null,
  repository text not null,
  ref text not null,
  added_at integer not null,
  primary key (scope_key, id),
  check (
    (authority = 'user'
      and owner_user_id is not null
      and scope_key = org_id || ':user:' || owner_user_id)
    or (authority = 'organization'
      and owner_user_id is null
      and scope_key = org_id || ':organization')
  )
);

create index agent_plugin_sources_by_reader
  on agent_plugin_sources (org_id, authority, owner_user_id);
