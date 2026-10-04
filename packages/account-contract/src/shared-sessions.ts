import { asRecord } from "@claxedo/helpers/guards"
import type { DecodeResult } from "./operation-definition"

export type SharedSession = {
  session_id: string
  workspace_id: string
  project_id: string
  title: string | null
  owner_name: string | null
  level: "follow" | "send"
}

export function sharedSessions(raw: unknown): DecodeResult<{ sessions: SharedSession[] }> {
  const body = asRecord(raw)
  if (!Array.isArray(body?.sessions)) return { ok: false, reason: "expected sessions" }
  const sessions: SharedSession[] = []
  for (const value of body.sessions) {
    const row = asRecord(value)
    if (!row || typeof row.session_id !== "string" || !row.session_id || typeof row.workspace_id !== "string" || !row.workspace_id
      || typeof row.project_id !== "string" || !row.project_id || (row.title !== null && typeof row.title !== "string")
      || (row.owner_name !== null && typeof row.owner_name !== "string") || (row.level !== "follow" && row.level !== "send")) {
      return { ok: false, reason: "invalid shared session" }
    }
    sessions.push({ session_id: row.session_id, workspace_id: row.workspace_id, project_id: row.project_id, title: row.title, owner_name: row.owner_name, level: row.level })
  }
  return { ok: true, value: { sessions } }
}
