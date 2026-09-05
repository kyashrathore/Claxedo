import {
  agentPluginSourceKind,
  type AgentPluginSourceRecord,
} from "@claxedo/server-core/agent-plugins/sources/registry"
import {
  AgentPluginSourceRegistryError,
  type AgentPluginSourceRegistry,
} from "@claxedo/server-core/agent-plugins/sources/routes"
import type { AgentPluginSqliteDatabase } from "../activation/sqlite-store"

/**
 * Create-only, in the same database the activation store opens.
 *
 * The unsigned rail has one actor -- the machine -- so a source needs no owner
 * column and no authority column: every row here is machine-wide, exactly like
 * the activation rows beside it.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_plugin_sources (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  repository TEXT NOT NULL,
  ref TEXT NOT NULL,
  added_at INTEGER NOT NULL
);
`

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function toRecord(row: unknown): AgentPluginSourceRecord {
  if (!record(row)
    || typeof row.id !== "string"
    || typeof row.owner !== "string"
    || typeof row.repository !== "string"
    || typeof row.ref !== "string"
    || typeof row.added_at !== "number") {
    throw new Error("SQLite returned an invalid Agent Plugins source row")
  }
  return {
    id: row.id,
    kind: agentPluginSourceKind("user"),
    label: `${row.owner}/${row.repository}`,
    owner: row.owner,
    repository: row.repository,
    ref: row.ref,
    authority: "user",
    addedAt: row.added_at,
  }
}

/** Machine-wide Agent Plugin source registry, the unsigned twin of the D1 store. */
export class SqliteAgentPluginSourceStore implements AgentPluginSourceRegistry<void> {
  constructor(private readonly db: AgentPluginSqliteDatabase) {
    db.exec(SCHEMA)
  }

  async list(): Promise<readonly AgentPluginSourceRecord[]> {
    return this.db
      .prepare("SELECT id, owner, repository, ref, added_at FROM agent_plugin_sources ORDER BY added_at, id")
      .all()
      .map(toRecord)
  }

  canRemove() {
    return true
  }

  async add(_actor: void, source: AgentPluginSourceRecord) {
    this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT id FROM agent_plugin_sources WHERE id = ?")
        .get(source.id)
      if (existing != null) {
        throw new AgentPluginSourceRegistryError("source-exists", `Source ${source.id} is already registered`)
      }
      this.db
        .prepare("INSERT INTO agent_plugin_sources (id, owner, repository, ref, added_at) VALUES (?, ?, ?, ?, ?)")
        .run(source.id, source.owner, source.repository, source.ref, source.addedAt)
    })()
  }

  async remove(_actor: void, id: string) {
    this.db.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM agent_plugin_sources WHERE id = ?").get(id)
      if (existing == null) {
        throw new AgentPluginSourceRegistryError("source-unknown", `Source ${id} is not registered`)
      }
      this.db.prepare("DELETE FROM agent_plugin_sources WHERE id = ?").run(id)
    })()
  }
}
