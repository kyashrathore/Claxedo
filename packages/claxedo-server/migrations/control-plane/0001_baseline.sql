CREATE TABLE actors (
  actor_id text primary key,
  user_id text references users (user_id) deferrable initially deferred,
  kind text not null check (kind in ('human', 'agent')),
  state text not null check (state in ('active', 'suspended', 'revoked')),
  created_at integer not null,
  updated_at integer not null,
  revoked_at integer,
  check ((kind = 'human' and user_id is not null) or kind = 'agent'),
  check ((state = 'revoked') = (revoked_at is not null))
);

CREATE TABLE agent_plugin_artifact_pins (
  scope_key text not null,
  plugin_instance_id text not null,
  authority text not null check (authority in ('user', 'organization', 'claxedo')),
  org_id text references orgs (org_id) deferrable initially deferred,
  owner_user_id text references users (user_id) deferrable initially deferred,
  artifact_digest text not null check (
    substr(artifact_digest, 1, 7) = 'sha256:'
    and length(artifact_digest) = 71
    and substr(artifact_digest, 8) not glob '*[^0-9a-f]*'
  ),
  source_id text not null,
  relative_path text not null,
  source_revision text not null,
  updated_at integer not null,
  primary key (scope_key, plugin_instance_id),
  check (
    (authority = 'user'
      and org_id is not null and owner_user_id is not null
      and scope_key = org_id || ':user:' || owner_user_id)
    or (authority = 'organization'
      and org_id is not null and owner_user_id is null
      and scope_key = org_id || ':organization')
    or (authority = 'claxedo'
      and org_id is null and owner_user_id is null
      and scope_key = 'claxedo')
  )
);

CREATE TABLE agent_plugin_claxedo_defaults (
  plugin_instance_id text not null,
  harness_id text not null check (harness_id in ('opencode', 'claude', 'codex', 'cursor', 'acp')),
  updated_at integer not null,
  primary key (plugin_instance_id, harness_id)
);

CREATE TABLE agent_plugin_organization_defaults (
  org_id text not null references orgs (org_id) deferrable initially deferred,
  plugin_instance_id text not null,
  harness_id text not null check (harness_id in ('opencode', 'claude', 'codex', 'cursor', 'acp')),
  updated_at integer not null,
  primary key (org_id, plugin_instance_id, harness_id)
);

CREATE TABLE agent_plugin_project_overrides (
  org_id text not null references orgs (org_id) deferrable initially deferred,
  owner_user_id text not null references users (user_id) deferrable initially deferred,
  project_id text not null references projects (project_id) deferrable initially deferred,
  plugin_instance_id text not null,
  harness_id text not null check (harness_id in ('opencode', 'claude', 'codex', 'cursor', 'acp')),
  enabled integer not null check (enabled in (0, 1)),
  updated_at integer not null,
  primary key (org_id, owner_user_id, project_id, plugin_instance_id, harness_id)
);

CREATE TABLE agent_plugin_revisions (
  org_id text primary key references orgs (org_id) deferrable initially deferred,
  revision integer not null check (revision >= 0),
  last_operation_id text,
  last_operation_revision integer,
  updated_at integer not null,
  check ((last_operation_id is null) = (last_operation_revision is null))
);

CREATE TABLE agent_plugin_sources (
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

CREATE TABLE agent_plugin_user_defaults (
  org_id text not null references orgs (org_id) deferrable initially deferred,
  owner_user_id text not null references users (user_id) deferrable initially deferred,
  plugin_instance_id text not null,
  harness_id text not null check (harness_id in ('opencode', 'claude', 'codex', 'cursor', 'acp')),
  enabled integer not null check (enabled in (0, 1)),
  updated_at integer not null,
  primary key (org_id, owner_user_id, plugin_instance_id, harness_id)
);

CREATE TABLE "auth_identities" (
  adapter text not null check (adapter in ('better-auth', 'custom')),
  issuer text not null,
  subject text not null,
  user_id text not null references users (user_id) deferrable initially deferred,
  linked_at integer not null,
  unlinked_at integer,
  primary key (adapter, issuer, subject)
);

CREATE TABLE authority_audit_events (
  event_id text primary key,
  deployment_id text not null check (length(deployment_id) between 1 and 200),
  user_id text,
  actor_id text,
  org_id text,
  project_id text,
  workspace_id text,
  unverified_attempted_workspace_id text check (
    unverified_attempted_workspace_id is null or length(unverified_attempted_workspace_id) <= 300
  ),
  action text not null check (length(action) between 1 and 200),
  result text not null check (result in ('allow', 'deny')),
  reason text check (reason is null or length(reason) <= 500),
  metadata_json text check (
    metadata_json is null or (json_valid(metadata_json) and length(cast(metadata_json as blob)) <= 4096)
  ),
  created_at integer not null,
  foreign key (actor_id, user_id) references actors (actor_id, user_id) deferrable initially deferred,
  foreign key (workspace_id, org_id, project_id)
    references workspaces (workspace_id, org_id, project_id) deferrable initially deferred,
  check ((actor_id is null and user_id is null) or (actor_id is not null and user_id is not null)),
  check (
    (workspace_id is null and org_id is null and project_id is null)
    or (workspace_id is not null and org_id is not null and project_id is not null)
  ),
  check (workspace_id is null or unverified_attempted_workspace_id is null),
  check ((result = 'allow' and reason is null) or (result = 'deny' and reason is not null))
);

CREATE TABLE authority_batch_assertions (
  assertion_id text primary key,
  passed integer not null check (passed = 1)
);

CREATE TABLE channel_identity_bindings (
  binding_id text primary key,
  deployment_id text not null,
  channel text not null,
  external_user_id text not null,
  user_id text not null references users (user_id) deferrable initially deferred,
  actor_id text not null references actors (actor_id) deferrable initially deferred,
  bound_by_actor_id text not null references actors (actor_id) deferrable initially deferred,
  created_at integer not null,
  revoked_at integer, identity_version integer not null default 0
  check (identity_version in (0, 1)),
  unique (binding_id, deployment_id)
);

CREATE TABLE document_shares (
  id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES orgs(org_id),
  target TEXT NOT NULL CHECK (target IN ('person', 'team', 'link')),
  target_id TEXT NOT NULL CHECK (length(target_id) > 0),
  level TEXT NOT NULL CHECK (level IN ('view', 'edit')),
  created_by TEXT NOT NULL REFERENCES users(user_id),
  revoked_at INTEGER,
  CHECK (target <> 'link' OR (level = 'view' AND length(target_id) = 64))
);

CREATE TABLE host_assignment_readiness (
  workspace_id text primary key,
  enrollment_id text not null,
  generation integer not null,
  revision integer not null,
  ready_at integer not null
);

CREATE TABLE host_enrollment_requests (
  request_id text primary key,
  owner_user_id text not null references users (user_id) deferrable initially deferred,
  owner_actor_id text not null references actors (actor_id) deferrable initially deferred,
  host_id text not null,
  nonce text not null unique,
  expires_at integer not null,
  used_at integer,
  used_signature_hash text,
  created_at integer not null
);

CREATE TABLE host_enrollments (
  enrollment_id text primary key,
  owner_user_id text not null references users (user_id) deferrable initially deferred,
  owner_actor_id text not null references actors (actor_id) deferrable initially deferred,
  host_id text not null,
  public_key_json text not null check (json_valid(public_key_json)),
  display_name text,
  last_seen_at integer not null,
  expires_at integer not null,
  paused_at integer,
  revoked_at integer,
  last_signature_hash text,
  created_at integer not null,
  updated_at integer not null, acked_workspace_ids text, acked_at integer, session_authority text, key_version integer not null default 1, serving_generation integer not null default 0, generation_acquired_at integer, enrolled_via text not null default 'account'
  check (enrolled_via in ('account', 'invitation')), scope_json text
  check (scope_json is null or json_valid(scope_json)), scope_revision integer not null default 0, sealing_public_key_json text
  check (sealing_public_key_json is null or json_valid(sealing_public_key_json)), provider_config_sealed text, provider_config_revision integer not null default 0, provider_config_acked_revision integer not null default 0, provider_config_updated_at integer, provider_config_sealed_key_json text
  check (provider_config_sealed_key_json is null or json_valid(provider_config_sealed_key_json)), provider_config_provider_ids text
  check (provider_config_provider_ids is null or json_valid(provider_config_provider_ids)),
  unique (owner_actor_id, host_id)
);

CREATE TABLE host_invitations (
  invitation_id text primary key,
  owner_user_id text not null references users (user_id) deferrable initially deferred,
  owner_actor_id text not null references actors (actor_id) deferrable initially deferred,
  org_id text not null,
  secret_hash text not null,
  display_name text,
  scope_json text not null check (json_valid(scope_json)),
  expires_at integer not null,
  redeemed_at integer,
  redeemed_enrollment_id text,
  redeemed_host_id text,
  redeemed_public_key_fingerprint text,
  created_by_actor_id text not null references actors (actor_id) deferrable initially deferred,
  created_at integer not null,
  revoked_at integer
);

CREATE TABLE host_request_nonces (
  enrollment_id text not null,
  nonce text not null,
  expires_at integer not null,
  primary key (enrollment_id, nonce)
);

CREATE TABLE host_signature_uses (
  signature_hash text primary key,
  signature_domain text not null check (
    signature_domain in ('local-register', 'local-heartbeat', 'host-enroll', 'host-heartbeat')
  ),
  actor_id text not null references actors (actor_id) deferrable initially deferred,
  workspace_id text,
  host_id text not null,
  used_at integer not null
);

CREATE TABLE host_workspace_assignments (
  workspace_id text primary key,
  host_id text not null,
  org_id text not null,
  owner_user_id text not null references users (user_id) deferrable initially deferred,
  owner_actor_id text not null references actors (actor_id) deferrable initially deferred,
  assigned_at integer not null,
  updated_at integer not null
, revision integer not null default 1);

CREATE TABLE "hosted_connection_attempts" (
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

CREATE TABLE hosted_connections (
  connection_id text primary key,
  org_id text not null references orgs (org_id) deferrable initially deferred,
  owner_user_id text references users (user_id) deferrable initially deferred,
  integration_id text not null,
  granted_capabilities_json text not null check (json_valid(granted_capabilities_json)),
  fields_json text not null default '{}' check (json_valid(fields_json)),
  account_label text,
  created_at integer not null,
  updated_at integer not null
);

CREATE TABLE "hosted_provider_account_sources" (
  org_id text not null,
  user_id text not null,
  provider_id text not null,
  source text not null check (source in ('own', 'org')),
  updated_at integer not null,
  primary key (org_id, user_id, provider_id)
);

CREATE TABLE hosted_provider_auth_attempts (
  id text primary key not null,
  org_id text not null,
  secret_envelope text not null,
  expires_at integer not null
);

CREATE TABLE hosted_provider_credentials (
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

CREATE TABLE mcp_oauth_clients (
  issuer text primary key,
  client_id text not null,
  client_secret_ref text,
  registration_json text not null check (json_valid(registration_json)),
  registered_at integer not null
);

CREATE TABLE org_invitation_admissions (
  user_id text primary key references users(user_id) on delete cascade,
  invitation_id text not null references org_invitations(id)
);

CREATE TABLE org_invitations (
  id text primary key,
  org_id text not null references orgs(org_id),
  email text not null check (email = lower(trim(email))),
  role text not null check (role in ('member', 'admin', 'owner')),
  token_hash text not null unique,
  invited_by text not null references users(user_id),
  created_at integer not null,
  expires_at integer not null,
  accepted_at integer,
  revoked_at integer
);

CREATE TABLE org_memberships (
  org_id text not null references orgs (org_id) deferrable initially deferred,
  user_id text not null references users (user_id) deferrable initially deferred,
  role text not null check (role in ('member', 'admin', 'owner')),
  created_at integer not null,
  updated_at integer not null,
  revoked_at integer,
  primary key (org_id, user_id)
);

CREATE TABLE orgs (
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

CREATE TABLE plugin_backend_activations (
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

CREATE TABLE project_memberships (
  project_id text not null references projects (project_id) deferrable initially deferred,
  user_id text not null references users (user_id) deferrable initially deferred,
  role text not null check (role in ('viewer', 'editor', 'admin', 'owner')),
  created_at integer not null,
  updated_at integer not null,
  revoked_at integer,
  primary key (project_id, user_id)
);

CREATE TABLE projection_command_idempotency (
  cache_key text primary key,
  fingerprint text not null,
  state text not null check (state in ('in_flight', 'completed')),
  claim_id text not null,
  result_json text,
  expires_at integer not null
);

CREATE TABLE projects (
  project_id text primary key,
  org_id text not null references orgs (org_id) deferrable initially deferred,
  repo_key text not null,
  owner_user_id text not null references users (user_id) deferrable initially deferred,
  created_at integer not null,
  updated_at integer not null,
  deleted_at integer,
  unique (project_id, org_id),
  unique (org_id, repo_key)
);

CREATE TABLE runtime_access_tokens (
  jti text primary key,
  deployment_id text not null,
  workspace_id text not null,
  org_id text not null,
  project_id text not null,
  host_id text not null,
  principal_kind text not null check (principal_kind in ('user', 'service')),
  actor_id text not null,
  actor_kind text not null check (actor_kind in ('human', 'agent')),
  role text not null check (role in ('viewer', 'editor', 'admin', 'owner')),
  minted_for_user_id text references users (user_id) deferrable initially deferred,
  expires_at integer not null,
  revoked_at integer,
  created_at integer not null, session_id text, share_grant_id text,
  foreign key (workspace_id, org_id, project_id)
    references workspaces (workspace_id, org_id, project_id) deferrable initially deferred,
  check (
    (principal_kind = 'user' and actor_kind = 'human' and minted_for_user_id is not null)
    or (principal_kind = 'service' and actor_kind = 'agent' and minted_for_user_id is null)
  )
);

CREATE TABLE sandbox_leases (
  workspace_id text primary key,
  lease_id text not null,
  home_region text not null default 'us-east',
  epoch integer not null default 1,
  status text not null default 'pending',
  driver text not null,
  driver_resource_id text,
  driver_snapshot_id text,
  sandbox_id text,
  url text,
  retry_count integer not null default 0,
  next_retry_at integer,
  last_heartbeat_at integer,
  last_activity_at integer,
  last_health_failure_at integer,
  last_error text,
  compute_class text,
  accel_base_image_id text,
  accel_prepared_image_id text,
  accel_snapshot_id text,
  labels_json text check (labels_json is null or json_valid(labels_json)),
  checkpoint_json text check (checkpoint_json is null or json_valid(checkpoint_json)),
  persistence_json text check (persistence_json is null or json_valid(persistence_json)),
  restore_json text check (restore_json is null or json_valid(restore_json)),
  created_at integer not null,
  updated_at integer not null
, routing_id TEXT);

CREATE TABLE sandbox_passes (
  jti text primary key,
  audience text not null,
  user_id text not null,
  org_id text not null,
  project_id text,
  workspace_id text not null,
  session_id text,
  issued_at integer not null,
  expires_at integer not null,
  revoked_at integer,
  revoked_reason text
);

CREATE TABLE session_messages (
  session_id text not null,
  workspace_id text not null,
  org_id text not null,
  project_id text not null,
  message_id text not null,
  author_actor_id text references actors (actor_id) deferrable initially deferred,
  role text not null,
  ordinal integer not null check (ordinal >= 0),
  turn_id text,
  data_json text not null check (json_valid(data_json)),
  snapshot_generation integer not null check (snapshot_generation >= 1),
  created_at integer not null,
  updated_at integer not null,
  primary key (session_id, message_id),
  foreign key (session_id, workspace_id, org_id, project_id)
    references sessions (session_id, workspace_id, org_id, project_id) deferrable initially deferred
);

CREATE TABLE session_reads (
  user_id text not null references users (user_id) on delete cascade,
  session_id text not null references sessions (session_id) on delete cascade,
  seen_at integer,
  settled_at integer,
  primary key (user_id, session_id)
);

CREATE TABLE session_registration_operations (
  operation_id text primary key,
  session_id text not null unique,
  workspace_id text not null,
  org_id text not null,
  project_id text not null,
  creator_actor_id text not null references actors (actor_id) deferrable initially deferred,
  operation_kind text not null check (operation_kind in ('create', 'fork')),
  parent_session_id text,
  requested_title text,
  state text not null check (
    state in ('reserved', 'registered', 'reconciliation_required', 'compensation_pending', 'compensated')
  ),
  state_reason text,
  created_at integer not null,
  updated_at integer not null,
  foreign key (workspace_id, org_id, project_id)
    references workspaces (workspace_id, org_id, project_id) deferrable initially deferred,
  check (
    (operation_kind = 'create' and parent_session_id is null)
    or (operation_kind = 'fork' and parent_session_id is not null)
  )
);

CREATE TABLE session_share_grants (
  grant_id text primary key,
  session_id text not null,
  workspace_id text not null,
  org_id text not null,
  project_id text not null,
  target_user_id text not null references users (user_id) deferrable initially deferred,
  granted_by_actor_id text not null references actors (actor_id) deferrable initially deferred,
  granted_at integer not null,
  revoked_at integer, level text not null default 'follow'
  check (level in ('follow', 'send')),
  foreign key (session_id, workspace_id, org_id, project_id)
    references sessions (session_id, workspace_id, org_id, project_id) deferrable initially deferred
);

CREATE TABLE session_turn_grants (
  grant_id text primary key,
  session_id text not null,
  workspace_id text not null,
  org_id text not null,
  project_id text not null,
  actor_id text not null references actors (actor_id) deferrable initially deferred,
  intent text not null check (intent in ('child_completion', 'queued_prompt')),
  subject_session_id text,
  turn_id text,
  turn_id_prefix text,
  issued_at integer not null,
  expires_at integer not null check (expires_at > issued_at),
  redeemed_at integer,
  redeemed_turn_id text,
  revoked_at integer,
  revoke_reason text,
  check ((turn_id is not null) + (turn_id_prefix is not null) = 1),
  foreign key (session_id, workspace_id, org_id, project_id)
    references sessions (session_id, workspace_id, org_id, project_id) deferrable initially deferred
);

CREATE TABLE session_turn_leases (
  session_id text primary key,
  workspace_id text not null,
  org_id text not null,
  project_id text not null,
  turn_id text not null,
  lease_id text not null unique,
  fencing_token integer not null check (fencing_token >= 1),
  actor_id text not null references actors (actor_id) deferrable initially deferred,
  acquired_at integer not null,
  expires_at integer not null check (expires_at > acquired_at),
  released_at integer,
  foreign key (session_id, workspace_id, org_id, project_id)
    references sessions (session_id, workspace_id, org_id, project_id) deferrable initially deferred
);

CREATE TABLE session_turn_producers (
  session_id text not null,
  workspace_id text not null,
  org_id text not null,
  project_id text not null,
  turn_id text not null,
  fencing_token integer not null check (fencing_token >= 1),
  actor_id text not null references actors (actor_id) deferrable initially deferred,
  admitted_at integer not null,
  primary key (session_id, turn_id),
  unique (session_id, fencing_token),
  foreign key (session_id, workspace_id, org_id, project_id)
    references sessions (session_id, workspace_id, org_id, project_id) deferrable initially deferred
);

CREATE TABLE sessions (
  session_id text primary key,
  operation_id text not null unique references session_registration_operations (operation_id) deferrable initially deferred,
  workspace_id text not null,
  org_id text not null,
  project_id text not null,
  creator_actor_id text not null references actors (actor_id) deferrable initially deferred,
  lifecycle_generation integer not null check (lifecycle_generation >= 1),
  title text,
  created_at integer not null,
  updated_at integer not null,
  deleted_at integer,
  max_event_ordinal integer not null default 0 check (max_event_ordinal >= 0),
  snapshot_generation integer not null default 0 check (snapshot_generation >= 0),
  snapshot_hash text,
  snapshot_token text, last_human_turn_at integer, archived_at integer, status text check (status is null or status in ('idle', 'busy', 'retry', 'interrupted')), status_at integer, awaiting_input integer not null default 0 check (awaiting_input in (0, 1)), runtime_updated_at integer, last_turn_status text check (last_turn_status is null or last_turn_status in ('completed', 'failed', 'cancelled')), last_turn_completed_at integer, background_agents integer not null default 0 check (background_agents >= 0), background_shells integer not null default 0 check (background_shells >= 0), background_other integer not null default 0 check (background_other >= 0),
  unique (session_id, workspace_id, org_id, project_id),
  foreign key (workspace_id, org_id, project_id)
    references workspaces (workspace_id, org_id, project_id) deferrable initially deferred
);

CREATE TABLE task_attachments (
  scope_id text not null,
  task_id text not null,
  attachment_id text not null,
  position integer not null,
  filename text not null,
  mime text not null,
  size integer not null,
  bytes blob not null,
  created_at integer not null,
  primary key (scope_id, task_id, attachment_id)
);

CREATE TABLE task_command_receipts (
  scope_id text not null,
  client_request_id text not null,
  command_name text not null,
  request_hash text not null,
  result text not null,
  created_at integer not null,
  primary key (scope_id, client_request_id)
);

CREATE TABLE task_presets (
  scope_id text not null,
  preset_id text not null,
  revision integer not null,
  owner_id text not null,
  name text not null,
  instructions text not null,
  execution text not null,
  configurations text not null,
  archived_at integer,
  created_at integer not null,
  updated_at integer not null, agent_startable integer not null default 0,
  primary key (scope_id, preset_id)
);

CREATE TABLE task_session_links (
  scope_id text not null,
  task_id text not null,
  slot text not null,
  attempt integer not null,
  session_id text not null,
  session_workspace_id text,
  continued_from_session_id text,
  continued_from_workspace_id text,
  preset_id text not null,
  preset_revision integer not null,
  preset_name_at_start text not null,
  configuration_digest text not null,
  handoff_text text,
  created_at integer not null, started_from_session_id text, started_from_workspace_id text, placement text not null default 'local', started_by text not null default 'person' check (started_by in ('person', 'agent')),
  primary key (scope_id, task_id, slot, attempt)
);

CREATE TABLE task_write_guards (
  refusal text not null,
  check (false)
);

CREATE TABLE tasks (
  scope_id text not null,
  task_id text not null,
  revision integer not null,
  project_id text not null,
  number integer not null,
  workspace_id text,
  parent_task_id text,
  created_from_session_id text,
  created_from_workspace_id text,
  title text not null,
  description text not null,
  status text not null,
  child_set_revision integer not null,
  archived_at integer,
  created_at integer not null,
  updated_at integer not null, child_number integer not null default 0,
  primary key (scope_id, task_id)
);

CREATE TABLE team_memberships (
  team_id text not null references teams (team_id) deferrable initially deferred,
  user_id text not null references users (user_id) deferrable initially deferred,
  role text not null check (role in ('member', 'admin', 'owner')),
  created_at integer not null,
  updated_at integer not null,
  revoked_at integer,
  primary key (team_id, user_id)
);

CREATE TABLE team_project_grants (
  team_id text not null references teams (team_id) deferrable initially deferred,
  project_id text not null references projects (project_id) deferrable initially deferred,
  role text not null check (role in ('viewer', 'editor', 'admin')),
  created_by_user_id text not null references users (user_id) deferrable initially deferred,
  created_at integer not null,
  updated_at integer not null,
  revoked_at integer,
  primary key (team_id, project_id)
);

CREATE TABLE teams (
  team_id text primary key,
  org_id text not null references orgs (org_id) deferrable initially deferred,
  name text not null,
  is_default integer not null default 0 check (is_default in (0, 1)),
  created_by_user_id text not null references users (user_id) deferrable initially deferred,
  created_at integer not null,
  updated_at integer not null,
  deleted_at integer
);

CREATE TABLE usage_turn_facts (
  host_id text not null,
  session_ref text not null,
  session_id text not null,
  message_id text not null,
  revision integer not null check (revision >= 1),
  payload_hash text not null,
  org_id text not null,
  user_id text not null,
  turn_id text not null,
  workspace_id text,
  observed_at integer not null,
  completed_at integer,
  settlement text not null check (settlement in ('provisional', 'final', 'partial', 'unavailable', 'recovered')),
  status text not null check (status in ('running', 'completed', 'error', 'stopped', 'interrupted_by_steer', 'process_lost')),
  location text not null check (location in ('local', 'cloud-workspace')),
  harness text not null,
  provider_id text not null,
  model_id text not null,
  native_session_id text,
  input_tokens integer,
  output_tokens integer,
  reasoning_tokens integer,
  cache_read_tokens integer,
  cache_write_tokens integer,
  cache_write_1h_tokens integer,
  quality_json text not null,
  recorded_at integer not null,
  primary key (host_id, session_ref, message_id)
);

CREATE TABLE user_agent_config (
  user_id text primary key references users (user_id),
  config_json text not null,
  updated_at integer not null
);

CREATE TABLE "user_deployed_owner_bootstrap_claims" (
  deployment_id text primary key,
  claim_hash text not null unique check (
    substr(claim_hash, 1, 7) = 'sha256:'
    and length(claim_hash) = 71
    and substr(claim_hash, 8) not glob '*[^0-9a-f]*'
  ),
  admitted_identity_hash text not null check (
    substr(admitted_identity_hash, 1, 7) = 'sha256:'
    and length(admitted_identity_hash) = 71
    and substr(admitted_identity_hash, 8) not glob '*[^0-9a-f]*'
  ),
  expires_at integer not null,
  consumed_at integer,
  consumed_adapter text check (consumed_adapter in ('better-auth', 'custom')),
  consumed_issuer text,
  consumed_subject text,
  created_at integer not null,
  check (
    (consumed_at is null and consumed_adapter is null and consumed_issuer is null and consumed_subject is null)
    or
    (consumed_at is not null and consumed_adapter is not null and consumed_issuer is not null and consumed_subject is not null)
  )
);

CREATE TABLE users (
  user_id text primary key,
  state text not null check (state in ('active', 'suspended', 'deleted')),
  created_at integer not null,
  updated_at integer not null,
  suspended_at integer,
  deleted_at integer,
  check ((state = 'suspended') = (suspended_at is not null)),
  check ((state = 'deleted') = (deleted_at is not null))
);

CREATE TABLE workspaces (
  workspace_id text primary key,
  org_id text not null,
  project_id text not null,
  owner_user_id text not null references users (user_id) deferrable initially deferred,
  backing text not null check (backing in ('local-worktree', 'cloud-vm')),
  display_name text not null,
  home_region text,
  repo_url text,
  repo_name text,
  git_branch text,
  remote_directory text,
  repo_connection_id text,
  created_at integer not null,
  updated_at integer not null,
  deleted_at integer, host_assignment_revision integer not null default 0,
  foreign key (project_id, org_id) references projects (project_id, org_id) deferrable initially deferred
);

CREATE UNIQUE INDEX actors_one_human_per_user
  on actors (user_id) where kind = 'human';

CREATE UNIQUE INDEX actors_scope_identity
  on actors (actor_id, user_id);

CREATE INDEX agent_plugin_artifact_pins_by_owner
  on agent_plugin_artifact_pins (org_id, authority, owner_user_id, plugin_instance_id);

CREATE INDEX agent_plugin_sources_by_reader
  on agent_plugin_sources (org_id, authority, owner_user_id);

CREATE INDEX auth_identities_by_user
  on auth_identities (user_id, unlinked_at);

CREATE INDEX authority_audit_events_by_actor_created
  on authority_audit_events (deployment_id, actor_id, created_at desc, event_id desc);

CREATE INDEX authority_audit_events_by_deployment_created
  on authority_audit_events (deployment_id, created_at desc, event_id desc);

CREATE INDEX authority_audit_events_by_workspace_created
  on authority_audit_events (deployment_id, workspace_id, created_at desc, event_id desc);

CREATE UNIQUE INDEX channel_identity_bindings_active_external
  on channel_identity_bindings (deployment_id, channel, external_user_id)
  where revoked_at is null and identity_version = 1;

CREATE INDEX channel_identity_bindings_by_actor
  on channel_identity_bindings (deployment_id, actor_id, revoked_at, created_at);

CREATE INDEX channel_identity_bindings_legacy_external
  on channel_identity_bindings (deployment_id, channel, external_user_id)
  where identity_version = 0;

CREATE INDEX document_shares_document ON document_shares(document_id, revoked_at);

CREATE INDEX document_shares_grantee ON document_shares(org_id, target, target_id) WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX document_shares_link ON document_shares(target_id) WHERE target = 'link';

CREATE INDEX host_assignment_readiness_by_enrollment
  on host_assignment_readiness (enrollment_id);

CREATE INDEX host_enrollment_requests_by_expiry
  on host_enrollment_requests (expires_at, used_at, request_id);

CREATE INDEX host_enrollments_by_owner_activity
  on host_enrollments (owner_actor_id, last_seen_at desc, enrollment_id);

CREATE INDEX host_invitations_by_owner
  on host_invitations (owner_actor_id, created_at desc, invitation_id);

CREATE INDEX host_invitations_by_redeemed_enrollment
  on host_invitations (redeemed_enrollment_id);

CREATE INDEX host_request_nonces_by_expiry
  on host_request_nonces (expires_at);

CREATE INDEX host_workspace_assignments_by_host
  on host_workspace_assignments (host_id);

CREATE INDEX hosted_connection_attempts_by_status_expiry
  on hosted_connection_attempts (status, expires_at);

CREATE INDEX hosted_connections_by_partition
  on hosted_connections (org_id, owner_user_id, integration_id);

CREATE UNIQUE INDEX hosted_connections_one_per_partition
  on hosted_connections (org_id, coalesce(owner_user_id, ''), integration_id);

CREATE UNIQUE INDEX hosted_provider_credentials_owner_provider
  on hosted_provider_credentials (org_id, ifnull(owner, ''), provider_id);

CREATE INDEX org_invitations_org on org_invitations(org_id, created_at);

CREATE INDEX org_memberships_by_user
  on org_memberships (user_id, revoked_at, org_id);

CREATE UNIQUE INDEX orgs_one_org_per_deployment
  on orgs (deployment_id) where kind = 'deployment' and deleted_at is null;

CREATE UNIQUE INDEX orgs_one_personal_per_owner
  on orgs (owner_user_id) where kind = 'personal' and deleted_at is null;

CREATE INDEX project_memberships_by_user
  on project_memberships (user_id, revoked_at, project_id);

CREATE INDEX projection_command_idempotency_expires_at on projection_command_idempotency (expires_at);

CREATE INDEX projects_by_owner
  on projects (owner_user_id, deleted_at, project_id);

CREATE INDEX runtime_access_tokens_by_actor_host
  on runtime_access_tokens (deployment_id, actor_id, host_id, revoked_at, expires_at);

CREATE INDEX runtime_access_tokens_by_workspace_host
  on runtime_access_tokens (deployment_id, workspace_id, host_id, revoked_at, expires_at);

CREATE INDEX runtime_access_tokens_by_workspace_user
  on runtime_access_tokens (workspace_id, minted_for_user_id, revoked_at, expires_at);

CREATE INDEX sandbox_leases_by_sandbox on sandbox_leases (sandbox_id);

CREATE INDEX sandbox_leases_by_status on sandbox_leases (status);

CREATE INDEX sandbox_leases_by_updated on sandbox_leases (updated_at);

CREATE INDEX sandbox_passes_org_idx on sandbox_passes (org_id, audience, expires_at);

CREATE INDEX sandbox_passes_workspace_idx on sandbox_passes (workspace_id, audience);

CREATE INDEX session_messages_by_session_ordinal
  on session_messages (session_id, ordinal);

CREATE INDEX session_messages_by_session_turn
  on session_messages (session_id, turn_id, ordinal);

CREATE INDEX session_registration_operations_by_state
  on session_registration_operations (state, updated_at, operation_id);

CREATE UNIQUE INDEX session_share_grants_active_user
  on session_share_grants (session_id, target_user_id)
  where revoked_at is null;

CREATE INDEX session_share_grants_by_session
  on session_share_grants (session_id, revoked_at, granted_at, grant_id);

CREATE INDEX session_share_grants_by_user
  on session_share_grants (target_user_id, revoked_at, session_id);

CREATE INDEX session_share_grants_by_workspace
  on session_share_grants (workspace_id, revoked_at, grant_id);

CREATE INDEX session_turn_grants_by_session
  on session_turn_grants (session_id, revoked_at);

CREATE INDEX session_turn_grants_by_subject
  on session_turn_grants (subject_session_id, revoked_at);

CREATE INDEX session_turn_leases_by_expiry
  on session_turn_leases (released_at, expires_at, session_id);

CREATE INDEX sessions_by_creator
  on sessions (workspace_id, creator_actor_id, deleted_at, session_id);

CREATE INDEX sessions_by_project_human_turn
  on sessions (project_id, deleted_at, archived_at, last_human_turn_at, created_at);

CREATE INDEX sessions_by_workspace_human_turn
  on sessions (workspace_id, deleted_at, archived_at, last_human_turn_at, created_at);

CREATE INDEX sessions_by_workspace_updated
  on sessions (workspace_id, updated_at desc, session_id);

CREATE INDEX task_attachments_task_idx on task_attachments (scope_id, task_id, position);

CREATE INDEX task_presets_page_idx on task_presets (scope_id, owner_id, created_at, preset_id);

CREATE INDEX task_session_links_session_idx on task_session_links (scope_id, session_id);

CREATE INDEX tasks_child_page_idx on tasks (scope_id, parent_task_id, created_at, task_id);

CREATE UNIQUE INDEX tasks_number_idx on tasks (scope_id, project_id, number, child_number);

CREATE INDEX tasks_project_page_idx on tasks (scope_id, project_id, created_at, task_id);

CREATE INDEX team_memberships_by_user
  on team_memberships (user_id, revoked_at, team_id);

CREATE INDEX team_project_grants_by_project
  on team_project_grants (project_id, revoked_at, team_id);

CREATE INDEX teams_by_org
  on teams (org_id, deleted_at, name, team_id);

CREATE UNIQUE INDEX teams_one_default_per_org
  on teams (org_id) where is_default = 1 and deleted_at is null;

CREATE INDEX usage_turn_facts_by_owner_observed
  on usage_turn_facts (org_id, user_id, observed_at);

CREATE INDEX usage_turn_facts_by_turn
  on usage_turn_facts (host_id, session_ref, turn_id);

CREATE INDEX workspaces_by_org
  on workspaces (org_id, deleted_at, workspace_id);

CREATE INDEX workspaces_by_owner
  on workspaces (owner_user_id, deleted_at, workspace_id);

CREATE INDEX workspaces_by_project
  on workspaces (project_id, deleted_at, workspace_id);

CREATE UNIQUE INDEX workspaces_scope_identity
  on workspaces (workspace_id, org_id, project_id);

CREATE TRIGGER actors_identity_immutable
before update of user_id, kind on actors
when new.user_id is not old.user_id or new.kind != old.kind
BEGIN
  select raise(abort, 'actor identity is immutable');
end;

CREATE TRIGGER auth_identities_user_immutable
before update of user_id on auth_identities
when new.user_id != old.user_id
BEGIN
  select raise(abort, 'auth identity user is immutable');
end;

CREATE TRIGGER authority_audit_events_no_update
before update on authority_audit_events
BEGIN
  select raise(abort, 'authority audit is append-only');
end;

CREATE TRIGGER channel_identity_binding_intent_immutable
before update of deployment_id, channel, external_user_id, user_id, actor_id,
  bound_by_actor_id, created_at, identity_version
on channel_identity_bindings
when new.deployment_id != old.deployment_id
  or new.channel != old.channel
  or new.external_user_id != old.external_user_id
  or new.user_id != old.user_id
  or new.actor_id != old.actor_id
  or new.bound_by_actor_id != old.bound_by_actor_id
  or new.created_at != old.created_at
  or new.identity_version != old.identity_version
BEGIN
  select raise(abort, 'channel identity binding intent is immutable');
end;

CREATE TRIGGER channel_identity_binding_version_current
before insert on channel_identity_bindings
when new.identity_version != 1
BEGIN
  select raise(abort, 'channel identity binding must be written at the current identity version');
end;

CREATE TRIGGER host_enrollment_request_intent_immutable
before update of owner_user_id, owner_actor_id, host_id, nonce, created_at
on host_enrollment_requests
when new.owner_user_id != old.owner_user_id or new.owner_actor_id != old.owner_actor_id
  or new.host_id != old.host_id or new.nonce != old.nonce or new.created_at != old.created_at
BEGIN
  select raise(abort, 'host enrollment request intent is immutable');
end;

CREATE TRIGGER host_enrollment_scope_immutable
before update of enrollment_id, owner_user_id, owner_actor_id, host_id, created_at
on host_enrollments
when new.enrollment_id != old.enrollment_id or new.owner_user_id != old.owner_user_id
  or new.owner_actor_id != old.owner_actor_id or new.host_id != old.host_id
  or new.created_at != old.created_at
BEGIN
  select raise(abort, 'host enrollment scope is immutable');
end;

CREATE TRIGGER projects_scope_immutable
before update of org_id, repo_key on projects
when new.org_id != old.org_id or new.repo_key != old.repo_key
BEGIN
  select raise(abort, 'project scope is immutable');
end;

CREATE TRIGGER runtime_access_token_intent_immutable
before update of deployment_id, workspace_id, org_id, project_id, host_id,
  principal_kind, actor_id, actor_kind, role, minted_for_user_id, expires_at, created_at
on runtime_access_tokens
when new.deployment_id != old.deployment_id
  or new.workspace_id != old.workspace_id
  or new.org_id != old.org_id
  or new.project_id != old.project_id
  or new.host_id != old.host_id
  or new.principal_kind != old.principal_kind
  or new.actor_id != old.actor_id
  or new.actor_kind != old.actor_kind
  or new.role != old.role
  or new.minted_for_user_id is not old.minted_for_user_id
  or new.expires_at != old.expires_at
  or new.created_at != old.created_at
BEGIN
  select raise(abort, 'runtime access token intent is immutable');
end;

CREATE TRIGGER session_registration_intent_immutable
before update of session_id, workspace_id, org_id, project_id, creator_actor_id,
  operation_kind, parent_session_id, requested_title, created_at
on session_registration_operations
when new.session_id != old.session_id
  or new.workspace_id != old.workspace_id
  or new.org_id != old.org_id
  or new.project_id != old.project_id
  or new.creator_actor_id != old.creator_actor_id
  or new.operation_kind != old.operation_kind
  or new.parent_session_id is not old.parent_session_id
  or new.requested_title is not old.requested_title
  or new.created_at != old.created_at
BEGIN
  select raise(abort, 'session registration intent is immutable');
end;

CREATE TRIGGER session_registration_state_transition
before update of state on session_registration_operations
when new.state != old.state and not (
  (old.state = 'reserved' and new.state in ('registered', 'reconciliation_required', 'compensation_pending'))
  or (old.state = 'reconciliation_required' and new.state in ('registered', 'compensation_pending'))
  or (old.state = 'compensation_pending' and new.state in ('compensated', 'reconciliation_required'))
)
BEGIN
  select raise(abort, 'invalid session registration state transition');
end;

CREATE TRIGGER session_share_intent_immutable
before update of session_id, workspace_id, org_id, project_id,
  target_user_id, granted_by_actor_id, granted_at
on session_share_grants
when new.session_id != old.session_id
  or new.workspace_id != old.workspace_id
  or new.org_id != old.org_id
  or new.project_id != old.project_id
  or new.target_user_id != old.target_user_id
  or new.granted_by_actor_id != old.granted_by_actor_id
  or new.granted_at != old.granted_at
BEGIN
  select raise(abort, 'session share intent is immutable');
END;

CREATE TRIGGER session_share_target_scope
before insert on session_share_grants
when not exists (
  select 1 from org_memberships om
  join users u on u.user_id = om.user_id and u.state = 'active'
  where om.org_id = new.org_id and om.user_id = new.target_user_id and om.revoked_at is null
)
BEGIN
  select raise(abort, 'session share target belongs to another organization');
END;

CREATE TRIGGER session_turn_grant_redeemed_once
before update of redeemed_at, redeemed_turn_id on session_turn_grants
when old.redeemed_at is not null
BEGIN
  select raise(abort, 'session turn grant is already redeemed');
end;

CREATE TRIGGER session_turn_lease_scope_immutable
before update of session_id, workspace_id, org_id, project_id
on session_turn_leases
when new.session_id != old.session_id
  or new.workspace_id != old.workspace_id
  or new.org_id != old.org_id
  or new.project_id != old.project_id
BEGIN
  select raise(abort, 'session turn lease scope is immutable');
end;

CREATE TRIGGER session_turn_producer_after_insert
after insert on session_turn_leases
BEGIN
  insert into session_turn_producers (
    session_id, workspace_id, org_id, project_id, turn_id, fencing_token, actor_id, admitted_at
  ) values (
    new.session_id, new.workspace_id, new.org_id, new.project_id,
    new.turn_id, new.fencing_token, new.actor_id, new.acquired_at
  );
end;

CREATE TRIGGER session_turn_producer_after_takeover
after update of turn_id, fencing_token on session_turn_leases
when new.fencing_token != old.fencing_token
BEGIN
  insert into session_turn_producers (
    session_id, workspace_id, org_id, project_id, turn_id, fencing_token, actor_id, admitted_at
  ) values (
    new.session_id, new.workspace_id, new.org_id, new.project_id,
    new.turn_id, new.fencing_token, new.actor_id, new.acquired_at
  );
end;

CREATE TRIGGER sessions_scope_immutable
before update of operation_id, workspace_id, org_id, project_id, creator_actor_id,
  lifecycle_generation, created_at
on sessions
when new.operation_id != old.operation_id
  or new.workspace_id != old.workspace_id
  or new.org_id != old.org_id
  or new.project_id != old.project_id
  or new.creator_actor_id != old.creator_actor_id
  or new.lifecycle_generation != old.lifecycle_generation
  or new.created_at != old.created_at
BEGIN
  select raise(abort, 'session scope is immutable');
end;

CREATE TRIGGER team_membership_org_scope
before insert on team_memberships
when not exists (
  select 1 from teams t
  join org_memberships om on om.org_id = t.org_id and om.user_id = new.user_id and om.revoked_at is null
  join users u on u.user_id = new.user_id and u.state = 'active'
  where t.team_id = new.team_id and t.deleted_at is null
)
BEGIN
  select raise(abort, 'team member must belong to the team organization');
END;

CREATE TRIGGER team_project_grant_org_scope
before insert on team_project_grants
when not exists (
  select 1 from teams t
  join projects p on p.project_id = new.project_id and p.org_id = t.org_id and p.deleted_at is null
  where t.team_id = new.team_id and t.deleted_at is null
)
BEGIN
  select raise(abort, 'team project grant belongs to another organization');
END;

CREATE TRIGGER user_deployed_owner_bootstrap_identity_immutable
before update of consumed_adapter, consumed_issuer, consumed_subject on user_deployed_owner_bootstrap_claims
when old.consumed_at is not null and (
  new.consumed_adapter is not old.consumed_adapter
  or new.consumed_issuer is not old.consumed_issuer
  or new.consumed_subject is not old.consumed_subject
)
BEGIN
  select raise(abort, 'bootstrap owner identity is immutable');
end;

CREATE TRIGGER workspaces_scope_immutable
before update of org_id, project_id on workspaces
when new.org_id != old.org_id or new.project_id != old.project_id
BEGIN
  select raise(abort, 'workspace scope is immutable');
end;
