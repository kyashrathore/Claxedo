-- The plugin backend each organization runs: the plugin's manifest and the
-- content hash of the bundle the supervisor loads for it. `active = 0` is a
-- plugin the organization has deactivated, and the supervisor refuses its
-- routes. `epoch` rises on every activation and deactivation and is never
-- reused, so a capability issued under one activation is dead under every
-- later one, including an identical reactivation. The bundle bytes live in
-- the plugin artifact bucket under their hash.

create table plugin_backend_activations (
  org_id text not null references orgs (org_id) deferrable initially deferred,
  plugin_id text not null,
  epoch integer not null check (epoch >= 1),
  active integer not null check (active in (0, 1)),
  bundle_hash text not null check (length(bundle_hash) = 64 and bundle_hash not glob '*[^0-9a-f]*'),
  manifest_json text not null check (json_valid(manifest_json)),
  changed_by text not null references users (user_id) deferrable initially deferred,
  changed_at integer not null,
  primary key (org_id, plugin_id)
);
