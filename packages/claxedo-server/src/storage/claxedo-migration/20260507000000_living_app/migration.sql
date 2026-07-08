CREATE TABLE IF NOT EXISTS claxedo_living_app (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  shell_spec_json TEXT NOT NULL DEFAULT '{}',
  backend_contract_json TEXT NOT NULL DEFAULT '{}',
  action_bindings_json TEXT NOT NULL DEFAULT '{}',
  data_schema_json TEXT NOT NULL DEFAULT '{}',
  sync_config_json TEXT NOT NULL DEFAULT '{}',
  prompt TEXT NOT NULL DEFAULT '',
  source_session_id TEXT,
  process_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS claxedo_living_app_workspace_idx
  ON claxedo_living_app (workspace_id);

CREATE INDEX IF NOT EXISTS claxedo_living_app_status_idx
  ON claxedo_living_app (status);

CREATE INDEX IF NOT EXISTS claxedo_living_app_updated_idx
  ON claxedo_living_app (updated_at);

CREATE TABLE IF NOT EXISTS claxedo_living_app_data_source (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS claxedo_living_app_data_source_app_idx
  ON claxedo_living_app_data_source (app_id);

CREATE INDEX IF NOT EXISTS claxedo_living_app_data_source_kind_idx
  ON claxedo_living_app_data_source (kind);

CREATE TABLE IF NOT EXISTS claxedo_living_app_event (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS claxedo_living_app_event_app_idx
  ON claxedo_living_app_event (app_id);

CREATE INDEX IF NOT EXISTS claxedo_living_app_event_created_idx
  ON claxedo_living_app_event (app_id, created_at);
