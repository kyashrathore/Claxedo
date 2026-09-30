-- The plugin backend each organization runs: the plugin's manifest and the
-- content hash of the bundle the supervisor loads for it. A missing row is a
-- plugin the organization has not activated, and the supervisor refuses its
-- routes. The bundle bytes live in the plugin artifact bucket under their hash.

create table plugin_backend_activations (
  org_id text not null references orgs (org_id) deferrable initially deferred,
  plugin_id text not null,
  bundle_hash text not null check (length(bundle_hash) = 64 and bundle_hash not glob '*[^0-9a-f]*'),
  manifest_json text not null check (json_valid(manifest_json)),
  activated_by text not null references users (user_id) deferrable initially deferred,
  activated_at integer not null,
  primary key (org_id, plugin_id)
);
