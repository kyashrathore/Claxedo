-- The migration creates an empty ledger. Only the authenticated deployment
-- workflow may author the initial installed-disabled state.

create table documents_service_lifecycle (
  singleton integer not null primary key check (singleton = 1),
  initializer_operation_id text not null,
  state text not null check (state in ('installed_disabled', 'enabling', 'enabled')),
  revision integer not null check (revision > 0),
  updated_at text not null
);

create table documents_service_lifecycle_audit (
  sequence integer primary key autoincrement,
  operation_id text not null unique,
  operation_intent text not null,
  action text not null check (action in ('initialize_disabled', 'record_probe', 'prepare_enable', 'commit_enable', 'disable', 'uninstall')),
  from_state text check (from_state is null or from_state in ('installed_disabled', 'enabling', 'enabled')),
  to_state text check (to_state is null or to_state in ('installed_disabled', 'enabling', 'enabled')),
  from_revision integer,
  to_revision integer,
  occurred_at text not null,
  check (
    (action = 'initialize_disabled' and from_state is null and to_state = 'installed_disabled' and from_revision is null and to_revision = 1) or
    (action in ('record_probe', 'prepare_enable', 'disable') and from_state is not null and to_state is not null and from_revision is not null and to_revision = from_revision + 1) or
    (action = 'commit_enable' and from_state = 'enabling' and to_state = 'enabled' and from_revision = to_revision) or
    (action = 'uninstall' and from_state = 'installed_disabled' and to_state is null and from_revision is not null and to_revision is null)
  )
);

create trigger documents_service_lifecycle_audit_no_update before update on documents_service_lifecycle_audit
begin select raise(abort, 'Documents lifecycle audit is append-only'); end;

create trigger documents_service_lifecycle_audit_no_delete before delete on documents_service_lifecycle_audit
begin select raise(abort, 'Documents lifecycle audit is append-only'); end;
