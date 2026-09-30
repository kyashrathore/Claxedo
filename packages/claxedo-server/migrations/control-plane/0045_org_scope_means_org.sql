-- "team" names only a row in `teams`. The three columns that used it for
-- something org-wide take the org's word instead, and rows already holding the
-- old value are rewritten as they are copied:
--
--   orgs.kind (from 0002): 'team' becomes 'shared'.
--   hosted_connection_attempts.scope (from 0020): 'team' becomes 'org'.
--   hosted_provider_account_sources.source (from 0044): 'team' becomes 'org'.
--
-- SQLite cannot ALTER a CHECK constraint, so each table is rebuilt with its
-- indexes.
--
-- Every foreign key to `orgs` is DEFERRABLE INITIALLY DEFERRED and none
-- cascades, so dropping `orgs` orphans the rows that reference it until commit. The
-- rebuild re-creates `orgs` under its own name and inserts the rows back, which
-- settles each orphan; building `orgs_next` and renaming it would leave every
-- orphan counted and fail the commit. The `orgs` statements carry no blank line
-- between them so a runner that splits a migration on blank lines still
-- applies them in one transaction.

create table orgs_previous as select * from orgs;
drop table orgs;
create table orgs (
  org_id text primary key,
  name text not null,
  kind text not null check (kind in ('personal', 'shared', 'deployment')),
  owner_user_id text not null references users (user_id) deferrable initially deferred,
  deployment_id text,
  created_at integer not null,
  updated_at integer not null,
  deleted_at integer,
  check ((kind = 'deployment') = (deployment_id is not null))
);
insert into orgs (org_id, name, kind, owner_user_id, deployment_id, created_at, updated_at, deleted_at)
  select org_id, name, case kind when 'team' then 'shared' else kind end,
    owner_user_id, deployment_id, created_at, updated_at, deleted_at
  from orgs_previous;
drop table orgs_previous;

create unique index orgs_one_personal_per_owner
  on orgs (owner_user_id) where kind = 'personal' and deleted_at is null;

create unique index orgs_one_org_per_deployment
  on orgs (deployment_id) where kind = 'deployment' and deleted_at is null;

create table hosted_connection_attempts_next (
  state text primary key,
  verifier text not null,
  integration_id text not null,
  device_code text,
  owner text,
  scope text not null check (scope in ('org', 'personal')),
  context_json text check (context_json is null or json_valid(context_json)),
  routing_json text check (routing_json is null or json_valid(routing_json)),
  status text not null check (status in ('pending', 'complete', 'failed', 'expired')),
  completing integer not null default 0 check (completing in (0, 1)),
  message text,
  expires_at integer not null,
  created_at integer not null,
  updated_at integer not null
);

insert into hosted_connection_attempts_next (
  state, verifier, integration_id, device_code, owner, scope, context_json, routing_json,
  status, completing, message, expires_at, created_at, updated_at
)
  select state, verifier, integration_id, device_code, owner, case scope when 'team' then 'org' else scope end,
    context_json, routing_json, status, completing, message, expires_at, created_at, updated_at
  from hosted_connection_attempts;

drop table hosted_connection_attempts;

alter table hosted_connection_attempts_next rename to hosted_connection_attempts;

create index hosted_connection_attempts_by_status_expiry
  on hosted_connection_attempts (status, expires_at);

create table hosted_provider_account_sources_next (
  org_id text not null,
  user_id text not null,
  provider_id text not null,
  source text not null check (source in ('own', 'org')),
  updated_at integer not null,
  primary key (org_id, user_id, provider_id)
);

insert into hosted_provider_account_sources_next (org_id, user_id, provider_id, source, updated_at)
  select org_id, user_id, provider_id, case source when 'team' then 'org' else source end, updated_at
  from hosted_provider_account_sources;

drop table hosted_provider_account_sources;

alter table hosted_provider_account_sources_next rename to hosted_provider_account_sources;
