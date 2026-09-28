import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"

export async function runtimeSources(dataDir: string, sessionId: string) {
  const root = path.join(dataDir, "agent-core")
  const workspaces = await fs.readdir(root)
  const sources: Array<{ type: string; payload: unknown; source: { dir: "in" | "out"; method: string; requestId?: string } }> = []
  for (const workspace of workspaces) {
    const file = path.join(root, workspace, "state.db")
    try {
      await fs.access(file)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue
      throw error
    }
    const db = new Database(file, { readonly: true })
    try {
      const rows = db.query("SELECT type, payload_json, source_json FROM runtime_journal WHERE session_id = ? AND source_json IS NOT NULL ORDER BY seq")
        .all(sessionId) as Array<{ type: string; payload_json: string; source_json: string }>
      for (const row of rows) sources.push({ type: row.type, payload: JSON.parse(row.payload_json), source: JSON.parse(row.source_json) })
    } finally {
      db.close()
    }
  }
  return sources
}
