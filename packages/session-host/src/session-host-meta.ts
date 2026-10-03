import type { SqlStorage } from "./turn-leases"

/**
 * The two facts a session host learns once and keeps: the workspace the
 * first verified relay host token named, and the workspace machine's
 * directory the control plane first answered for a turn's execution.
 */
export class SessionHostMeta {
  constructor(private readonly sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS session_host_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL)")
  }

  workspaceId(): string | undefined {
    return this.read("workspace_id")
  }

  claimWorkspace(workspaceId: string): void {
    this.sql.exec("INSERT OR IGNORE INTO session_host_meta VALUES ('workspace_id', ?)", workspaceId)
  }

  /** Whether `directory` is the session's machine directory, recording it when none was. */
  claimDirectory(directory: string): boolean {
    this.sql.exec("INSERT OR IGNORE INTO session_host_meta VALUES ('directory', ?)", directory)
    return this.read("directory") === directory
  }

  private read(name: string): string | undefined {
    const [row] = this.sql.exec("SELECT value FROM session_host_meta WHERE name = ?", name).toArray()
    return row ? String(row.value) : undefined
  }
}
