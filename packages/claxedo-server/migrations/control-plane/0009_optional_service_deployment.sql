-- Deployment workflows for optional services run outside request traffic, but
-- their lock and step receipts live with the authoritative installation
-- catalog.  A released lock row is retained so fencing tokens never go
-- backwards after a process crash or a new workflow runner takes over.

create table service_deployment_locks (
  environment_id text not null,
  deployment_id text not null,
  operation_id text not null,
  lease_token text not null,
  fencing_token integer not null check (fencing_token > 0),
  lease_expires_at integer not null check (lease_expires_at >= 0),
  acquired_at text not null,
  heartbeat_at text not null,
  released_at text,
  primary key (environment_id, deployment_id)
);

create table service_deployment_steps (
  environment_id text not null,
  deployment_id text not null,
  step_operation_id text not null,
  workflow_operation_id text not null,
  service_id text not null check (service_id in ('workgraph', 'documents')),
  service_build_id text not null,
  binding_provenance text not null,
  step text not null check (step in (
    'provision_resources', 'apply_migrations', 'deploy_dark', 'add_core_binding',
    'drain_operations', 'revoke_bridge', 'remove_core_binding', 'retire_resources'
  )),
  operation_intent text not null,
  state text not null check (state in ('started', 'completed')),
  result_json text,
  started_at text not null,
  completed_at text,
  primary key (environment_id, deployment_id, step_operation_id),
  check (
    (state = 'started' and result_json is null and completed_at is null) or
    (state = 'completed' and result_json is not null and completed_at is not null)
  )
);

create index service_deployment_steps_workflow_idx
  on service_deployment_steps (environment_id, deployment_id, workflow_operation_id, service_id);

create trigger service_deployment_steps_no_delete
before delete on service_deployment_steps
BEGIN
  select raise(abort, 'service deployment receipts are append-only');
end;
