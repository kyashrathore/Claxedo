-- A hosted provider account belongs to one person: a session spends its
-- owner's account, so two people in one org each keep their own row for the
-- same provider. A NULL owner is the org's own row: its team account for a
-- provider, or a connection, sandbox-driver or deployment secret. Rows keyed only by org
-- and provider name no owner and cannot be attributed to anyone, so they are
-- dropped rather than converted.
--
-- `id` is random, so nothing in a sandbox can name an account from who owns
-- it. One row per (owner, provider) is kept by an index over `ifnull(owner,
-- '')`, because a UNIQUE over the nullable column would admit two org rows for
-- one provider. `secret_envelope` is bound to `id`, so an envelope copied to
-- another row fails authentication.

drop table hosted_provider_credentials;

create table hosted_provider_credentials (
  id text not null,
  owner text,
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
  primary key (org_id, id)
);

create unique index hosted_provider_credentials_owner_provider
  on hosted_provider_credentials (org_id, ifnull(owner, ''), provider_id);

-- Which account one person's sessions spend for a provider: their own, or the
-- org's team account (the NULL-owner row). Only the chosen one is spent; a
-- provider with no row here is 'own'.
create table hosted_provider_account_sources (
  org_id text not null,
  user_id text not null,
  provider_id text not null,
  source text not null check (source in ('own', 'team')),
  updated_at integer not null,
  primary key (org_id, user_id, provider_id)
);
