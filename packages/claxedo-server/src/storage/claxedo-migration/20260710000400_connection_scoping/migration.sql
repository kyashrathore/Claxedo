CREATE TEMP TABLE claxedo_connection_id_map (
  integration_id TEXT PRIMARY KEY NOT NULL,
  id TEXT NOT NULL
);

INSERT INTO claxedo_connection_id_map (integration_id, id)
SELECT integration_id, lower(hex(randomblob(16)))
FROM claxedo_connection;

ALTER TABLE claxedo_connection RENAME TO claxedo_connection_legacy;

CREATE TABLE claxedo_connection (
  id TEXT PRIMARY KEY NOT NULL,
  integration_id TEXT NOT NULL,
  owner TEXT,
  account_label TEXT,
  granted_capabilities TEXT NOT NULL,
  fields TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (integration_id, owner)
);

CREATE UNIQUE INDEX claxedo_connection_team_integration_unique
  ON claxedo_connection (integration_id)
  WHERE owner IS NULL;

INSERT INTO claxedo_connection (
  id,
  integration_id,
  owner,
  account_label,
  granted_capabilities,
  fields,
  created_at,
  updated_at
)
SELECT
  map.id,
  legacy.integration_id,
  NULL,
  legacy.account_label,
  legacy.granted_capabilities,
  legacy.fields,
  legacy.created_at,
  legacy.updated_at
FROM claxedo_connection_legacy legacy
JOIN claxedo_connection_id_map map ON map.integration_id = legacy.integration_id;

UPDATE claxedo_provider_credential
SET provider_id = 'integration:' || (
  SELECT id
  FROM claxedo_connection_id_map
  WHERE integration_id = substr(claxedo_provider_credential.provider_id, 13)
)
WHERE provider_id IN (
  SELECT 'integration:' || integration_id
  FROM claxedo_connection_id_map
);

DROP TABLE claxedo_connection_legacy;
DROP TABLE claxedo_connection_id_map;
