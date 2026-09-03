-- Fixed first-party service installation ledger. Absence from
-- service_installations is the canonical uninstalled state; audit events are
-- retained after uninstall.

create table service_installations (
  environment_id text not null,
  deployment_id text not null,
  service_id text not null check (service_id in ('workgraph', 'documents')),
  protocol_version text not null check (protocol_version = 'claxedo.service.v1'),
  schema_version integer not null check (schema_version > 0),
  lifecycle_state text not null check (lifecycle_state in ('installed_disabled', 'enabled')),
  binding_name text not null,
  entrypoint text not null,
  binding_provenance text not null,
  probe_status text check (probe_status is null or probe_status in ('ready', 'unhealthy')),
  probe_checked_at text,
  service_build_id text,
  revision integer not null check (revision > 0),
  last_operation_id text not null,
  updated_at text not null,
  primary key (environment_id, deployment_id, service_id),
  unique (environment_id, deployment_id, last_operation_id),
  check (
    (service_id = 'workgraph' and binding_name = 'WORKGRAPH_SERVICE') or
    (service_id = 'documents' and binding_name = 'DOCUMENTS_SERVICE')
  ),
  check (
    (probe_status is null and probe_checked_at is null and service_build_id is null) or
    (probe_status is not null and probe_checked_at is not null and service_build_id is not null)
  )
);

create table service_installation_audit (
  environment_id text not null,
  deployment_id text not null,
  operation_id text not null,
  operation_intent text not null,
  service_id text not null check (service_id in ('workgraph', 'documents')),
  action text not null check (action in ('register_disabled', 'record_probe', 'enable', 'disable', 'uninstall')),
  from_revision integer,
  to_revision integer,
  occurred_at text not null,
  primary key (environment_id, deployment_id, operation_id),
  check (
    (action = 'register_disabled' and from_revision is null and to_revision = 1) or
    (action in ('record_probe', 'enable', 'disable') and from_revision is not null and to_revision = from_revision + 1) or
    (action = 'uninstall' and from_revision is not null and to_revision is null)
  )
);

create index service_installations_catalog_idx
  on service_installations (environment_id, deployment_id, lifecycle_state, service_id);

create index service_installation_audit_order_idx
  on service_installation_audit (environment_id, deployment_id, occurred_at, operation_id);

create trigger service_installation_audit_no_update
before update on service_installation_audit
BEGIN
  select raise(abort, 'service installation audit is append-only');
end;

create trigger service_installation_audit_no_delete
before delete on service_installation_audit
BEGIN
  select raise(abort, 'service installation audit is append-only');
end;
