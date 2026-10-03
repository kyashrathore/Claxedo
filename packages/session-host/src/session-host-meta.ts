import type { TurnExecutionAccess } from "@claxedo/harness/contract"
import type { SqlStorage } from "./turn-leases"

/**
 * The facts a session host learns and keeps: the workspace the first verified
 * relay host token named, and the workspace machine's directory the control
 * plane answered for a turn's execution, with the machine that answered it.
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

  /**
   * Whether `access.directory` is the session's machine directory. A sandbox
   * provisioned again gets a new routing id, and its directory is the
   * session's from then on; the same machine answering another is refused.
   */
  claimDirectory(access: Pick<TurnExecutionAccess, "directory" | "hostId" | "routingId">): boolean {
    const machine = JSON.stringify([access.hostId, access.routingId ?? null])
    const directory = this.read("directory")
    if (directory !== undefined && directory !== access.directory && this.read("machine") === machine) return false
    this.write("directory", access.directory)
    this.write("machine", machine)
    return true
  }

  private read(name: string): string | undefined {
    const [row] = this.sql.exec("SELECT value FROM session_host_meta WHERE name = ?", name).toArray()
    return row ? String(row.value) : undefined
  }

  private write(name: string, value: string): void {
    this.sql.exec("INSERT INTO session_host_meta VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", name, value)
  }
}
