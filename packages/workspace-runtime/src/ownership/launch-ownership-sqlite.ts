import { randomUUID } from "node:crypto"
import type {
  CreationIdentity,
  LaunchOwnershipRecord,
  LaunchOwnershipStore,
  LaunchOwnershipOwner,
  LaunchScope,
  PrepareLaunchInput,
  RetirementResult,
} from "@claxedo/agent-sdk-runtime/launch"
import { retirementSettled } from "@claxedo/agent-sdk-runtime/launch"
import { Log } from "../log"

const log = Log.create({ service: "launch-ownership" })

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
      owner_generation TEXT NOT NULL,
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
  `)
  // Forward-only, and before the index that reads it: a database written when
  // ownership carried no generation has rows no current runtime can claim, and
  // reconciliation must be free to retire them. The empty string is a
  // generation nothing will ever equal.
  if (!launchOwnershipColumns(db).includes("owner_generation")) {
    db.exec("ALTER TABLE launch_ownership ADD COLUMN owner_generation TEXT NOT NULL DEFAULT ''")
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS launch_ownership_unresolved
      ON launch_ownership (retired_at, workspace_id, owner_generation);
  `)
}

function launchOwnershipColumns(db: SqliteDatabase) {
  return db.prepare<{ name: string }>("PRAGMA table_info(launch_ownership)").all().map((row) => row.name)
}

type LaunchOwnershipRow = {
  launch_id: string
  owner_generation: string
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
 * Launch ownership on the owning runtime's own database.
 *
 * Forward-only: a row is written before the launch that might need it and is
 * never deleted while its cleanup is unresolved, because the row is the only
 * thing that will identify a survivor after this process is gone. A retirement
 * that left the leader alive, its group populated, or the outcome unknown keeps
 * `retired_at` null and stays in `listUnresolved`.
 */
export function sqliteLaunchOwnership(db: SqliteDatabase, owner: LaunchOwnershipOwner): LaunchOwnershipStore {
  // Both drivers report a change count; without one, a write against a launch
  // id nothing prepared would look like a success.
  const probe = db.prepare("UPDATE launch_ownership SET retired_at = retired_at WHERE launch_id = ?").run("")
  if (typeof (probe as { changes?: unknown } | undefined)?.changes !== "number") {
    throw new Error("This SQLite driver does not report a change count, so launch-ownership writes cannot be verified")
  }
  const write = (sql: string, params: unknown[]) => {
    const { changes } = db.prepare(sql).run(...params) as { changes: number }
    if (changes === 0) throw new Error(`No prepared launch matched ${String(params.at(-1))}`)
  }
  return {
    ownerGeneration: owner.ownerGeneration,

    async prepare(input: PrepareLaunchInput) {
      const prepared = {
        launchId: randomUUID(),
        ownerGeneration: owner.ownerGeneration,
        role: input.role,
        protocol: input.protocol,
        ...(input.parentOwnerId ? { parentOwnerId: input.parentOwnerId } : {}),
        scope: { ...owner.scope, ...input.scope },
        preparedAt: Date.now(),
      }
      db.prepare(`
        INSERT INTO launch_ownership (launch_id, owner_generation, role, protocol, parent_owner_id, workspace_id, session_id, directory, prepared_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        prepared.launchId,
        prepared.ownerGeneration,
        prepared.role,
        prepared.protocol,
        input.parentOwnerId ?? null,
        owner.scope.kind === "workspace" ? owner.scope.workspaceId : null,
        input.scope?.sessionId ?? null,
        input.scope?.directory ?? null,
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
      // COALESCE, not assignment: a later attempt that establishes less than
      // the one that settled this row must not reopen it.
      write(
        "UPDATE launch_ownership SET cleanup_json = ?, retired_at = COALESCE(retired_at, ?) WHERE launch_id = ?",
        [JSON.stringify(result), retirementSettled(result) ? Date.now() : null, launchId],
      )
    },

    async read(launchId: string) {
      const row = db.prepare<LaunchOwnershipRow>("SELECT * FROM launch_ownership WHERE launch_id = ?").get(launchId)
      return row ? launchOwnershipFromRow(row) : undefined
    },

    async listUnresolved(scope: LaunchScope) {
      // A standalone runtime's rows are the ones naming no workspace, which is
      // not the same query as "do not filter by workspace": that one would hand
      // this runtime every mounted workspace's launches to retire.
      const filters: string[] = ["retired_at IS NULL"]
      const params: unknown[] = []
      if (scope.kind === "workspace") {
        filters.push("workspace_id = ?")
        params.push(scope.workspaceId)
      } else {
        filters.push("workspace_id IS NULL")
      }
      for (const [column, value] of [
        ["session_id", scope.sessionId],
        ["directory", scope.directory],
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
    ownerGeneration: row.owner_generation,
    role: row.role as LaunchOwnershipRecord["role"],
    protocol: row.protocol as LaunchOwnershipRecord["protocol"],
    ...(row.parent_owner_id ? { parentOwnerId: row.parent_owner_id } : {}),
    scope: {
      ...(row.workspace_id ? { kind: "workspace" as const, workspaceId: row.workspace_id } : { kind: "standalone" as const }),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.directory ? { directory: row.directory } : {}),
    },
    preparedAt: row.prepared_at,
    ...identityOf(readOwnershipColumn(row.launch_id, "identity", row.identity_json)),
    ...(row.gate_nonce ? { gateNonce: row.gate_nonce } : {}),
    ...(row.identity_received_at ? { identityReceivedAt: row.identity_received_at } : {}),
    ...(row.activation_authorized_at ? { activationAuthorizedAt: row.activation_authorized_at } : {}),
    ...(row.activation_acknowledged_at ? { activationAcknowledgedAt: row.activation_acknowledged_at } : {}),
    ...(row.retired_at ? { retiredAt: row.retired_at } : {}),
    ...cleanupOf(readOwnershipColumn(row.launch_id, "cleanup", row.cleanup_json)),
  }
}

/**
 * A column that will not parse costs its field, never the row: without the row
 * nothing knows a launch happened at all, and a record missing its identity
 * reconciles as unknown, which is the honest answer.
 */
function readOwnershipColumn(launchId: string, field: string, raw: string | null): unknown {
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch (error) {
    log.error("a launch ownership column could not be read", { launchId, field, error: String(error) })
    return undefined
  }
}

/** Each caller names the one shape its column holds, in the one place it is known. */
function identityOf(value: unknown) {
  return value === undefined ? {} : { identity: value as CreationIdentity }
}

function cleanupOf(value: unknown) {
  return value === undefined ? {} : { cleanup: value as RetirementResult }
}
