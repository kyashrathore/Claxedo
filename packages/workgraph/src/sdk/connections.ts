/**
 * Provider connection store — DB-agnostic interface for `provider_connections_current`.
 *
 * Follows the same interface + implementation + factory pattern as IEventStore:
 *   IConnectionStore  →  SqliteConnectionStore  →  openSqliteConnectionStore(db)
 *
 * Note: `ConnectionFull` (with token) is used internally. `ConnectionRow` (no token)
 * is what public API endpoints return.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Public-facing view — token excluded. */
export interface ConnectionRow {
  connection_id: string
  provider: string
  name: string
  status: string
  error: string | null
  created_at: string
  updated_at: string
}

/** Internal view — includes token for auth resolution. */
export interface ConnectionFull extends ConnectionRow {
  token: string
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface IConnectionStore {
  /** Get full connection (including token) by ID. Returns null if not found. */
  get(connectionId: string): ConnectionFull | null
  /** List public (no-token) views of all connections, optionally filtered by provider. */
  list(provider?: string | null): ConnectionRow[]
  /** List full connections (with token) for a specific provider, newest first. */
  listByProvider(provider: string): ConnectionFull[]
  /** Insert or replace the connection record. Returns the current stored state. */
  upsert(conn: ConnectionFull): ConnectionFull
  /** Update status and error fields only. */
  updateStatus(connectionId: string, status: string, error: string | null): void
  /** Delete a connection by ID. */
  delete(connectionId: string): void
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

function toPublic(row: any): ConnectionRow {
  return {
    connection_id: row.connection_id,
    provider: row.provider,
    name: row.name,
    status: row.status,
    error: row.error ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function toFull(row: any): ConnectionFull {
  return { ...toPublic(row), token: row.token }
}

class SqliteConnectionStore implements IConnectionStore {
  constructor(private db: any) {}

  get(connectionId: string): ConnectionFull | null {
    const row = this.db
      .query("SELECT * FROM provider_connections_current WHERE connection_id = ?")
      .get(connectionId) as any
    return row ? toFull(row) : null
  }

  list(provider?: string | null): ConnectionRow[] {
    const rows = provider
      ? (this.db.query("SELECT * FROM provider_connections_current WHERE provider = ? ORDER BY updated_at DESC").all(provider) as any[])
      : (this.db.query("SELECT * FROM provider_connections_current ORDER BY updated_at DESC").all() as any[])
    return rows.map(toPublic)
  }

  listByProvider(provider: string): ConnectionFull[] {
    return (this.db
      .query("SELECT * FROM provider_connections_current WHERE provider = ? ORDER BY updated_at DESC")
      .all(provider) as any[]).map(toFull)
  }

  upsert(conn: ConnectionFull): ConnectionFull {
    const existing = this.get(conn.connection_id)
    if (existing) {
      this.db.run(
        "UPDATE provider_connections_current SET name = ?, token = ?, status = ?, error = ?, updated_at = ? WHERE connection_id = ?",
        [conn.name, conn.token, conn.status, conn.error, conn.updated_at, conn.connection_id],
      )
      // Remove other connections for the same provider (one-per-provider enforcement)
      this.db.run(
        "DELETE FROM provider_connections_current WHERE provider = ? AND connection_id != ?",
        [conn.provider, conn.connection_id],
      )
    } else {
      this.db.run(
        "INSERT INTO provider_connections_current (connection_id, provider, name, token, status, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [conn.connection_id, conn.provider, conn.name, conn.token, conn.status, conn.error, conn.created_at, conn.updated_at],
      )
    }
    return this.get(conn.connection_id)!
  }

  updateStatus(connectionId: string, status: string, error: string | null): void {
    this.db.run(
      "UPDATE provider_connections_current SET status = ?, error = ?, updated_at = ? WHERE connection_id = ?",
      [status, error, new Date().toISOString(), connectionId],
    )
  }

  delete(connectionId: string): void {
    this.db.run("DELETE FROM provider_connections_current WHERE connection_id = ?", [connectionId])
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create an IConnectionStore backed by the given bun:sqlite Database instance. */
export function openSqliteConnectionStore(db: any): IConnectionStore {
  return new SqliteConnectionStore(db)
}
