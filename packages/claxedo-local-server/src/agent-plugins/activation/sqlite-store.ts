import {
  AgentPluginActivationStoreError,
  type MutateMachineActivation,
  type UnsignedActivationSnapshot,
  type UnsignedAgentPluginActivationStore,
  type UnsignedKnownPlugin,
} from "@claxedo/server-core/agent-plugins/activation/store"
import {
  isAgentPluginHarnessId,
  type AgentPluginHarnessId,
} from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import type { ArtifactDigest } from "@claxedo/server-core/agent-plugins/activation/types"

/** The SQLite operations this feature owns; both Node and bundled Bun drivers implement it. */
export type AgentPluginSqliteDatabase = {
  exec(sql: string): unknown
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): unknown
  }
  transaction<T>(fn: () => T): () => T
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_plugin_activation_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL
);
INSERT OR IGNORE INTO agent_plugin_activation_meta (singleton, revision) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS agent_plugin_machine_pins (
  plugin_instance_id TEXT PRIMARY KEY,
  artifact_digest TEXT NOT NULL,
  source_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  source_revision TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_plugin_machine_overrides (
  plugin_instance_id TEXT NOT NULL,
  harness_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  PRIMARY KEY (plugin_instance_id, harness_id)
);

CREATE TABLE IF NOT EXISTS agent_plugin_claxedo_pins (
  plugin_instance_id TEXT PRIMARY KEY,
  artifact_digest TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_plugin_claxedo_defaults (
  plugin_instance_id TEXT NOT NULL,
  harness_id TEXT NOT NULL,
  PRIMARY KEY (plugin_instance_id, harness_id)
);
`

function harness(value: string): AgentPluginHarnessId {
  if (!isAgentPluginHarnessId(value)) {
    throw new AgentPluginActivationStoreError("unsupported-harness", `Unsupported agent plugin harness: ${value}`)
  }
  return value
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function artifactDigest(value: unknown): value is ArtifactDigest {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value)
}

function enabledRow(value: unknown): { enabled: 0 | 1 } | undefined {
  if (value == null) return undefined
  if (!record(value) || (value.enabled !== 0 && value.enabled !== 1)) {
    throw new Error("SQLite returned an invalid Agent Plugins activation row")
  }
  return { enabled: value.enabled }
}

function digestRow(value: unknown): { artifactDigest: ArtifactDigest } | undefined {
  if (value == null) return undefined
  if (!record(value) || !artifactDigest(value.artifact_digest)) {
    throw new Error("SQLite returned an invalid Agent Plugins artifact row")
  }
  return { artifactDigest: value.artifact_digest }
}

/**
 * Unsigned-local activation authority.
 *
 * The schema intentionally has no project or workspace column: the local UI's
 * "all projects" choice is one machine-wide fact. Every mutation advances one
 * database revision and commits an acquired artifact pin with its choices in
 * the same SQLite transaction.
 */
export class SqliteUnsignedAgentPluginActivationStore implements UnsignedAgentPluginActivationStore {
  constructor(private readonly db: AgentPluginSqliteDatabase) {
    db.exec(SCHEMA)
  }

  revision(): number {
    const row = this.db.prepare("SELECT revision FROM agent_plugin_activation_meta WHERE singleton = 1").get()
    if (!record(row) || typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 0) {
      throw new Error("SQLite returned an invalid Agent Plugins revision")
    }
    return row.revision
  }

  listKnown(): UnsignedKnownPlugin[] {
    const rows = this.db.prepare(`
      SELECT ids.plugin_instance_id, pins.artifact_digest, pins.source_id, pins.relative_path, pins.source_revision
      FROM (
        SELECT plugin_instance_id FROM agent_plugin_machine_pins
        UNION SELECT plugin_instance_id FROM agent_plugin_machine_overrides
        UNION SELECT plugin_instance_id FROM agent_plugin_claxedo_pins
        UNION SELECT plugin_instance_id FROM agent_plugin_claxedo_defaults
      ) AS ids
      LEFT JOIN agent_plugin_machine_pins AS pins ON pins.plugin_instance_id = ids.plugin_instance_id
      ORDER BY ids.plugin_instance_id
    `).all()
    return rows.map((row) => {
      if (!record(row)
        || typeof row.plugin_instance_id !== "string"
        || (row.artifact_digest !== null && !artifactDigest(row.artifact_digest))
        || (row.source_id !== null && typeof row.source_id !== "string")
        || (row.relative_path !== null && typeof row.relative_path !== "string")
        || (row.source_revision !== null && typeof row.source_revision !== "string")) {
        throw new Error("SQLite returned an invalid Agent Plugins retained row")
      }
      return {
        pluginInstanceId: row.plugin_instance_id,
        ...(row.artifact_digest && row.source_id && row.relative_path && row.source_revision
        ? {
            pin: {
              digest: row.artifact_digest,
              sourceId: row.source_id,
              relativePath: row.relative_path,
              sourceRevision: row.source_revision,
            },
          }
        : {}),
      }
    })
  }

  read(pluginInstanceId: string, harnessId: string): UnsignedActivationSnapshot {
    const supportedHarness = harness(harnessId)
    const machine = enabledRow(this.db.prepare(`
      SELECT enabled
      FROM agent_plugin_machine_overrides
      WHERE plugin_instance_id = ? AND harness_id = ?
    `).get(pluginInstanceId, supportedHarness))
    const localPin = digestRow(this.db.prepare(`
      SELECT artifact_digest
      FROM agent_plugin_machine_pins
      WHERE plugin_instance_id = ?
    `).get(pluginInstanceId))
    const claxedoDefault = enabledRow(this.db.prepare(`
      SELECT 1 AS enabled
      FROM agent_plugin_claxedo_defaults
      WHERE plugin_instance_id = ? AND harness_id = ?
    `).get(pluginInstanceId, supportedHarness))
    const claxedoPin = digestRow(this.db.prepare(`
      SELECT artifact_digest
      FROM agent_plugin_claxedo_pins
      WHERE plugin_instance_id = ?
    `).get(pluginInstanceId))

    return {
      revision: this.revision(),
      pluginInstanceId,
      harnessId: supportedHarness,
      ...(machine ? { machineOverride: machine.enabled === 1 } : {}),
      ...(claxedoDefault ? { claxedoDefault: true as const } : {}),
      pins: {
        ...(localPin ? { localMachine: localPin.artifactDigest } : {}),
        ...(claxedoPin ? { claxedo: claxedoPin.artifactDigest } : {}),
      },
    }
  }

  mutate(input: MutateMachineActivation): number {
    const harnessIds = [...new Set(input.harnessIds.map(harness))]
    return this.db.transaction(() => {
      const currentRevision = this.revision()
      if (currentRevision !== input.expectedRevision) {
        throw new AgentPluginActivationStoreError(
          "revision-conflict",
          `Agent plugin activation revision changed from ${input.expectedRevision} to ${currentRevision}`,
        )
      }

      if (input.artifact) {
        this.db.prepare(`
          INSERT INTO agent_plugin_machine_pins (
            plugin_instance_id, artifact_digest, source_id, relative_path, source_revision
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (plugin_instance_id) DO UPDATE SET
            artifact_digest = excluded.artifact_digest,
            source_id = excluded.source_id,
            relative_path = excluded.relative_path,
            source_revision = excluded.source_revision
        `).run(
          input.pluginInstanceId,
          input.artifact.digest,
          input.artifact.sourceId,
          input.artifact.relativePath,
          input.artifact.sourceRevision,
        )
      }

      if (input.choice === true) {
        const pin = this.db.prepare(`
          SELECT artifact_digest
          FROM agent_plugin_machine_pins
          WHERE plugin_instance_id = ?
        `).get(input.pluginInstanceId)
        if (!pin) {
          throw new AgentPluginActivationStoreError(
            "artifact-unavailable",
            `Plugin ${input.pluginInstanceId} has no retained machine artifact`,
          )
        }
      }

      const upsert = this.db.prepare(`
        INSERT INTO agent_plugin_machine_overrides (plugin_instance_id, harness_id, enabled)
        VALUES (?, ?, ?)
        ON CONFLICT (plugin_instance_id, harness_id) DO UPDATE SET enabled = excluded.enabled
      `)
      const remove = this.db.prepare(`
        DELETE FROM agent_plugin_machine_overrides
        WHERE plugin_instance_id = ? AND harness_id = ?
      `)
      for (const harnessId of harnessIds) {
        if (input.choice === undefined) remove.run(input.pluginInstanceId, harnessId)
        else upsert.run(input.pluginInstanceId, harnessId, input.choice ? 1 : 0)
      }

      const nextRevision = currentRevision + 1
      this.db.prepare("UPDATE agent_plugin_activation_meta SET revision = ? WHERE singleton = 1").run(nextRevision)
      return nextRevision
    })()
  }
}
