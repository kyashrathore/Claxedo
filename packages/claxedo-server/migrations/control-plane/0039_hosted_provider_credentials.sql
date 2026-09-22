-- The hosted control plane's provider credentials, one row per partition and
-- provider. `hostedOrgCredentials` (src/credentials/worker/index.ts) binds one
-- instance to one partition and scopes every statement by `org_id`, so a
-- provider id can never reach another tenant's row.
--
-- `org_id` is not a foreign key to `orgs`: the deployment-wide MCP OAuth
-- client secret is filed under the partition `deployment`, which names the
-- deployment itself rather than any tenant (agent-plugins/hosted-composition.ts).
--
-- `secret_envelope` is the only place the secret exists, as the `cenc1`
-- envelope from credentials/envelope.ts: AES-256-GCM under an HKDF subkey
-- derived from the KEK and the partition, so a row copied between partitions
-- fails authentication. The status rule lives in the store's statements: a
-- health or secret write keeps `revoked`, only `updateCredentialStatus` moves
-- off it.
create table hosted_provider_credentials (
  org_id text not null,
  provider_id text not null,
  kind text not null check (kind in ('api_key', 'oauth_token', 'subscription_session', 'sandbox_driver')),
  source text not null check (source in ('managed', 'local_only', 'env', 'upstream_sync')),
  label text,
  account_id text,
  status text not null check (status in ('available', 'expired', 'revoked', 'error')),
  health text check (health is null or health in ('ok', 'auth_failed', 'no_billing', 'rate_capped', 'expired')),
  expires_at integer,
  last_validated_at integer,
  last_error text,
  secret_envelope text not null,
  revision integer not null,
  created_at integer not null,
  updated_at integer not null,
  primary key (org_id, provider_id)
);
