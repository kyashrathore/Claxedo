import type { SqliteDatabase } from "../sqlite/database"

export type WorkspaceWorktreeRecord = {
  workspaceId: string
  sessionId: string
  branch: string
  baseCommit: string
  path: string
  state: "creating" | "active" | "repairing" | "failed"
  createdAt: number
  updatedAt: number
  lastActivityAt: number
}

export class WorktreeRecords {
  constructor(private readonly db: SqliteDatabase) {}

  put(record: WorkspaceWorktreeRecord) {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO workspace_worktree (
        session_id,
        workspace_id,
        branch,
        base_commit,
        path,
        state,
        created_at,
        updated_at,
        last_activity_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        record.sessionId,
        record.workspaceId,
        record.branch,
        record.baseCommit,
        record.path,
        record.state,
        record.createdAt,
        record.updatedAt,
        record.lastActivityAt,
      )
  }

  get(workspaceId: string, sessionId: string): WorkspaceWorktreeRecord | undefined {
    const row = this.db.prepare<{
      workspace_id: string
      session_id: string
      branch: string
      base_commit: string
      path: string
      state: WorkspaceWorktreeRecord["state"]
      created_at: number
      updated_at: number
      last_activity_at: number
    }>(`
      SELECT
        workspace_id,
        session_id,
        branch,
        base_commit,
        path,
        state,
        created_at,
        updated_at,
        last_activity_at
      FROM workspace_worktree
      WHERE workspace_id = ? AND session_id = ?
    `).get(workspaceId, sessionId)
    if (!row) return undefined
    return {
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      branch: row.branch,
      baseCommit: row.base_commit,
      path: row.path,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastActivityAt: row.last_activity_at,
    }
  }

  list(workspaceId: string): WorkspaceWorktreeRecord[] {
    return (
      this.db
        .prepare<{ session_id: string }>(
          `
      SELECT session_id
      FROM workspace_worktree
      WHERE workspace_id = ?
      ORDER BY last_activity_at DESC, session_id ASC
    `).all(workspaceId))
      .map((row) => this.get(workspaceId, row.session_id)!)
  }
}
