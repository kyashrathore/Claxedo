import { randomUUID } from "node:crypto"
import type {
  CreationIdentity,
  LaunchOwnershipRecord,
  LaunchOwnershipStore,
  LaunchScope,
  PrepareLaunchInput,
  RetirementResult,
} from "@claxedo/agent-sdk-runtime/launch"
import { retirementSettled } from "@claxedo/agent-sdk-runtime/launch"

/** The narrow slice of a SQLite handle this table needs. */
export type SqliteDatabase = {
  exec(sql: string): unknown
  prepare<Row = unknown>(sql: string): {
    run(...params: unknown[]): unknown
    get(...params: unknown[]): Row | null | undefined
    all(...params: unknown[]): Row[]
  }
}

export function migrateLaunchOwnership(db: SqliteDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS launch_ownership (
      launch_id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      protocol TEXT NOT NULL,
      parent_owner_id TEXT,
      workspace_id TEXT,
      session_id TEXT,
      directory TEXT,
      prepared_at INTEGER NOT NULL,
      identity_json TEXT,
      gate_nonce TEXT,
      identity_received_at INTEGER,
      activation_authorized_at INTEGER,
      activation_acknowledged_at INTEGER,
      retired_at INTEGER,
      cleanup_json TEXT
    );
    CREATE INDEX IF NOT EXISTS launch_ownership_unresolved
      ON launch_ownership (retired_at, directory, session_id);
  `)
}

type LaunchOwnershipRow = {
  launch_id: string
  role: string
  protocol: string
  parent_owner_id: string | null
  workspace_id: string | null
  session_id: string | null
  directory: string | null
  prepared_at: number
  identity_json: string | null
  gate_nonce: string | null
  identity_received_at: number | null
  activation_authorized_at: number | null
  activation_acknowledged_at: number | null
  retired_at: number | null
  cleanup_json: string | null
}

/**
 * Launch ownership on the workspace's own database.
 *
 * Forward-only: a row is written before the launch that might need it and is
 * never deleted while its cleanup is unresolved, because the row is the only
 * thing that will identify a survivor after this process is gone. A retirement
 * that left the leader alive, its group populated, or the outcome unknown keeps
 * `retired_at` null and stays in `listUnresolved`.
 */
export function sqliteLaunchOwnership(db: SqliteDatabase): LaunchOwnershipStore {
  const write = (sql: string, params: unknown[]) => {
    const changes = db.prepare(sql).run(...params) as { changes?: number } | undefined
    if (changes && typeof changes.changes === "number" && changes.changes === 0) {
      throw new Error(`No prepared launch matched ${String(params.at(-1))}`)
    }
  }
  return {
    async prepare(input: PrepareLaunchInput) {
      const prepared = {
        launchId: randomUUID(),
        role: input.role,
        protocol: input.protocol,
        ...(input.parentOwnerId ? { parentOwnerId: input.parentOwnerId } : {}),
        scope: input.scope,
        preparedAt: Date.now(),
      }
      db.prepare(`
        INSERT INTO launch_ownership (launch_id, role, protocol, parent_owner_id, workspace_id, session_id, directory, prepared_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        prepared.launchId,
        prepared.role,
        prepared.protocol,
        input.parentOwnerId ?? null,
        input.scope.workspaceId ?? null,
        input.scope.sessionId ?? null,
        input.scope.directory ?? null,
        prepared.preparedAt,
      )
      return prepared
    },

    async recordIdentity(launchId: string, identity: CreationIdentity, gateNonce?: string) {
      write(
        "UPDATE launch_ownership SET identity_json = ?, gate_nonce = ?, identity_received_at = ? WHERE launch_id = ?",
        [JSON.stringify(identity), gateNonce ?? null, Date.now(), launchId],
      )
    },

    async authorizeActivation(launchId: string) {
      write("UPDATE launch_ownership SET activation_authorized_at = ? WHERE launch_id = ?", [Date.now(), launchId])
    },

    async acknowledgeActivation(launchId: string) {
      write("UPDATE launch_ownership SET activation_acknowledged_at = ? WHERE launch_id = ?", [Date.now(), launchId])
    },

    async recordRetirement(launchId: string, result: RetirementResult) {
      write(
        "UPDATE launch_ownership SET cleanup_json = ?, retired_at = ? WHERE launch_id = ?",
        [JSON.stringify(result), retirementSettled(result) ? Date.now() : null, launchId],
      )
    },

    async read(launchId: string) {
      const row = db.prepare<LaunchOwnershipRow>("SELECT * FROM launch_ownership WHERE launch_id = ?").get(launchId)
      return row ? launchOwnershipFromRow(row) : undefined
    },

    async listUnresolved(scope?: LaunchScope) {
      const filters: string[] = ["retired_at IS NULL"]
      const params: unknown[] = []
      for (const [column, value] of [
        ["workspace_id", scope?.workspaceId],
        ["session_id", scope?.sessionId],
        ["directory", scope?.directory],
      ] as const) {
        if (value === undefined) continue
        filters.push(`${column} = ?`)
        params.push(value)
      }
      return db
        .prepare<LaunchOwnershipRow>(`SELECT * FROM launch_ownership WHERE ${filters.join(" AND ")} ORDER BY prepared_at`)
        .all(...params)
        .map(launchOwnershipFromRow)
    },
  }
}

function launchOwnershipFromRow(row: LaunchOwnershipRow): LaunchOwnershipRecord {
  return {
    launchId: row.launch_id,
    role: row.role as LaunchOwnershipRecord["role"],
    protocol: row.protocol as LaunchOwnershipRecord["protocol"],
    ...(row.parent_owner_id ? { parentOwnerId: row.parent_owner_id } : {}),
    scope: {
      ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.directory ? { directory: row.directory } : {}),
    },
    preparedAt: row.prepared_at,
    ...(row.identity_json ? { identity: JSON.parse(row.identity_json) as CreationIdentity } : {}),
    ...(row.gate_nonce ? { gateNonce: row.gate_nonce } : {}),
    ...(row.identity_received_at ? { identityReceivedAt: row.identity_received_at } : {}),
    ...(row.activation_authorized_at ? { activationAuthorizedAt: row.activation_authorized_at } : {}),
    ...(row.activation_acknowledged_at ? { activationAcknowledgedAt: row.activation_acknowledged_at } : {}),
    ...(row.retired_at ? { retiredAt: row.retired_at } : {}),
    ...(row.cleanup_json ? { cleanup: JSON.parse(row.cleanup_json) as RetirementResult } : {}),
  }
}
