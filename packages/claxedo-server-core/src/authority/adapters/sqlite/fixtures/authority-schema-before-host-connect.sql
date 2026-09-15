CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_identifier TEXT,
  workspace_id TEXT,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  reason TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE channel_identities (
  binding_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  token_identifier TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE host_enrollment_requests (
  request_id TEXT PRIMARY KEY,
  owner_token_identifier TEXT NOT NULL,
  host_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE host_enrollments (
  enrollment_id TEXT PRIMARY KEY,
  owner_token_identifier TEXT NOT NULL,
  host_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  display_name TEXT,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  paused_at INTEGER,
  paused_by TEXT,
  paused_reason TEXT,
  revoked_at INTEGER,
  -- The machine's last-acked served set (JSON array of public workspace ids),
  -- written only by a verified heartbeat v2 signature, plus when it was acked.
  acked_workspace_ids TEXT,
  acked_at INTEGER,
  -- How the runtime this machine serves composed its session access
  -- ('local' | 'managed-private'), as the machine declared it on its last
  -- heartbeat. NULL means it declared nothing, and a connection minted from
  -- this row then carries no stream scope at all.
  session_authority TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner_token_identifier, host_id)
);
CREATE TABLE host_workspace_assignments (
  workspace_id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  owner_token_identifier TEXT NOT NULL,
  second_device_open_at INTEGER,
  assigned_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE "legacy_runtime_access_tokens_pre_canonical_actor" (
  jti TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  minted_for_token_identifier TEXT NOT NULL,
  principal_kind TEXT,
  minted_for_actor_kind TEXT,
  workspace_role TEXT,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE "legacy_session_history_pre_private_sessions" (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  created_by_token_identifier TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  max_event_ordinal INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER
);
CREATE TABLE "legacy_session_messages_pre_private_sessions" (
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  author_actor_id TEXT,
  role TEXT,
  ordinal INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, message_id)
);
CREATE TABLE "legacy_session_participants_pre_private_sessions" (
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  actor_token_identifier TEXT NOT NULL,
  added_by_token_identifier TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (session_id, actor_token_identifier)
);
CREATE TABLE org_memberships (
  org_id TEXT NOT NULL,
  token_identifier TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, token_identifier)
);
CREATE TABLE orgs (
  org_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  owner_token_identifier TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE project_memberships (
  project_id TEXT NOT NULL,
  token_identifier TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, token_identifier)
);
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  repo_key TEXT NOT NULL,
  owner_token_identifier TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE runtime_access_tokens (
  jti TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  principal_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  role TEXT NOT NULL,
  minted_for_token_identifier TEXT,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE session_history (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  creator_actor_id TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- NULL means nobody has ever prompted this session. updated_at moves for an
  -- agent's turn too, so the session list cannot band on it.
  last_human_turn_at INTEGER,
  max_event_ordinal INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER
, snapshot_hash TEXT);
CREATE TABLE session_messages (
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  author_actor_id TEXT,
  role TEXT,
  ordinal INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, message_id)
);
CREATE TABLE session_participants (
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  participant_actor_id TEXT NOT NULL,
  added_by_actor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (session_id, participant_actor_id)
);
CREATE TABLE session_registration_operations (
  operation_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  creator_actor_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  parent_session_id TEXT,
  requested_title TEXT,
  state TEXT NOT NULL,
  state_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE session_share_grants (
  grant_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  granted_to_user_token_identifier TEXT,
  granted_to_org_id TEXT,
  granted_to_team_id TEXT,
  created_by_token_identifier TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE session_turn_leases (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  lease_id TEXT NOT NULL UNIQUE,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  actor_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > acquired_at),
  released_at INTEGER
);
CREATE TABLE session_turn_producers (
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  actor_id TEXT NOT NULL,
  admitted_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, turn_id),
  UNIQUE (session_id, fencing_token)
);
CREATE TABLE team_memberships (
  team_id TEXT NOT NULL,
  user_token_identifier TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_token_identifier)
);
CREATE TABLE team_project_grants (
  team_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_by_token_identifier TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (team_id, project_id)
);
CREATE TABLE teams (
  team_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_default INTEGER,
  created_by_token_identifier TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE users (
  token_identifier TEXT PRIMARY KEY,
  public_id TEXT NOT NULL,
  subject TEXT,
  issuer TEXT,
  name TEXT,
  image_url TEXT,
  kind TEXT NOT NULL DEFAULT 'human',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE workspace_memberships (
  workspace_id TEXT NOT NULL,
  token_identifier TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, token_identifier)
);
CREATE TABLE workspace_share_grants (
  grant_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  granted_to_token_identifier TEXT,
  granted_to_subject TEXT,
  granted_to_org_id TEXT,
  granted_to_team_id TEXT,
  role TEXT NOT NULL,
  created_by_token_identifier TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK (
    (granted_to_token_identifier IS NOT NULL)
    + (granted_to_subject IS NOT NULL)
    + (granted_to_org_id IS NOT NULL)
    + (granted_to_team_id IS NOT NULL) = 1
  )
);
CREATE TABLE workspaces (
  workspace_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  owner_token_identifier TEXT NOT NULL,
  backing TEXT NOT NULL,
  access TEXT NOT NULL,
  display_name TEXT,
  second_device_open_at INTEGER,
  home_region TEXT,
  repo_url TEXT,
  repo_name TEXT,
  git_branch TEXT,
  remote_directory TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX channel_identities_active_external
  ON channel_identities (channel, external_user_id)
  WHERE revoked_at IS NULL;
CREATE INDEX host_enrollment_requests_by_expires_at ON host_enrollment_requests (expires_at);
CREATE INDEX host_enrollment_requests_by_owner ON host_enrollment_requests (owner_token_identifier);
CREATE INDEX host_enrollments_by_expires_at ON host_enrollments (expires_at);
CREATE INDEX host_enrollments_by_owner ON host_enrollments (owner_token_identifier);
CREATE INDEX host_workspace_assignments_by_host
  ON host_workspace_assignments (host_id);
CREATE INDEX host_workspace_assignments_by_owner
  ON host_workspace_assignments (owner_token_identifier);
CREATE INDEX projects_by_org ON projects (org_id);
CREATE UNIQUE INDEX projects_by_org_repo_key ON projects (org_id, repo_key);
CREATE INDEX session_history_by_workspace_updated
  ON session_history (workspace_id, updated_at DESC);
CREATE INDEX session_participants_by_actor
  ON session_participants (participant_actor_id, revoked_at);
CREATE INDEX session_share_grants_by_session ON session_share_grants (session_id);
CREATE INDEX session_share_grants_by_team ON session_share_grants (granted_to_team_id);
CREATE INDEX session_share_grants_by_workspace ON session_share_grants (workspace_id);
CREATE INDEX session_turn_leases_by_expiry
  ON session_turn_leases (released_at, expires_at, session_id);
CREATE INDEX team_memberships_by_user ON team_memberships (user_token_identifier);
CREATE INDEX team_project_grants_by_project ON team_project_grants (project_id);
CREATE INDEX teams_by_org ON teams (org_id);
CREATE UNIQUE INDEX users_by_public_id ON users (public_id);
CREATE INDEX users_by_subject ON users (subject);
CREATE UNIQUE INDEX workspace_share_grants_active_target
        ON workspace_share_grants (workspace_id, target_key)
        WHERE revoked_at IS NULL AND target_key IS NOT NULL;
CREATE INDEX workspaces_by_org ON workspaces (org_id);
CREATE INDEX workspaces_by_project ON workspaces (project_id);
CREATE TRIGGER projects_tenant_reassignment
      BEFORE UPDATE OF org_id ON projects
      WHEN EXISTS (
        SELECT 1 FROM workspaces w WHERE w.project_id = OLD.project_id AND w.org_id != NEW.org_id
      ) BEGIN
        SELECT RAISE(ABORT, 'project_tenant_reassignment');
      END;
CREATE TRIGGER workspaces_tenant_project_insert
      BEFORE INSERT ON workspaces
      WHEN NOT EXISTS (
        SELECT 1 FROM projects p WHERE p.project_id = NEW.project_id AND p.org_id = NEW.org_id
      ) BEGIN
        SELECT RAISE(ABORT, 'workspace_project_tenant_conflict');
      END;
CREATE TRIGGER workspaces_tenant_project_update
      BEFORE UPDATE OF org_id, project_id ON workspaces
      WHEN NOT EXISTS (
        SELECT 1 FROM projects p WHERE p.project_id = NEW.project_id AND p.org_id = NEW.org_id
      ) BEGIN
        SELECT RAISE(ABORT, 'workspace_project_tenant_conflict');
      END;
PRAGMA user_version = 5;
