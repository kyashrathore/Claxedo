import type { D1Database } from "@cloudflare/workers-types"
import { updateSessionReader, type SessionReaderCommand, type SessionReaderResult } from "@claxedo/agent-runtime-contract"
import { storedSessionAttention, storedSessionReader } from "@claxedo/server-core/session/reader-contract"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import { maySql, type AuthorizationPrincipal } from "./authorization"
import { sessionRuntimeAvailableSql } from "./session-runtime-availability"

export async function writeD1SessionReader(database: D1Database, who: AuthorizationPrincipal, input: {
  sessionId: string
  workspaceId: string
  command: SessionReaderCommand
}, now: number): Promise<SessionReaderResult> {
  const access = maySql(who, "read", { kind: "session", alias: "s" })
  const available = sessionRuntimeAvailableSql(now)
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await database.prepare(`
      SELECT s.attention_json, r.state_json, ${available} AS runtime_available FROM sessions s
      LEFT JOIN session_readers r ON r.session_id = s.session_id AND r.user_id = ?
      WHERE s.session_id = ? AND s.workspace_id = ? AND s.deleted_at IS NULL AND ${access.sql}
    `).bind(who.userId, input.sessionId, input.workspaceId, ...access.bind).first<{ attention_json: string | null; state_json: string | null; runtime_available: number }>()
    if (!row) throw new ClaxedoError({ code: "session_not_found", message: "Session not found", status: 404 })
    if (input.command.kind === "settle" && row.runtime_available !== 1) throw new ClaxedoError({ code: "session_runtime_unavailable", message: "Session runtime is unavailable", status: 503 })
    const facts = storedSessionAttention(row.attention_json)
    if (!facts) throw new ClaxedoError({ code: "session_attention_unavailable", message: "Session activity is unavailable", status: 503 })
    const result = updateSessionReader(facts, storedSessionReader(row.state_json), input.command, now)
    if (!result.ok) return result
    const write = await database.prepare(`
      INSERT INTO session_readers (session_id, user_id, state_json)
      SELECT s.session_id, ?, ? FROM sessions s
      WHERE s.session_id = ? AND s.workspace_id = ? AND s.deleted_at IS NULL
        AND s.attention_json = ? AND ${access.sql} ${input.command.kind === "settle" ? `AND ${available}` : ""}
        AND (SELECT state_json FROM session_readers WHERE session_id = s.session_id AND user_id = ?) IS ?
      ON CONFLICT (session_id, user_id) DO UPDATE SET state_json = excluded.state_json
    `).bind(who.userId, JSON.stringify(result.state), input.sessionId, input.workspaceId,
      row.attention_json, ...access.bind, who.userId, row.state_json).run()
    if (write.meta.changes) return result
  }
  return { ok: false, reason: "reader_changed" }
}

export async function admitD1SessionCleanup(database: D1Database, who: AuthorizationPrincipal, input: {
  sessionId: string
  workspaceId: string
  generation: number
  readerRevision: number
}, orgId?: string) {
  const access = maySql(who, "control", { kind: "session", alias: "s" })
  const row = await database.prepare(`
    SELECT s.attention_json, r.state_json FROM sessions s
    LEFT JOIN session_readers r ON r.session_id = s.session_id AND r.user_id = ?
    WHERE s.session_id = ? AND s.workspace_id = ? AND ${access.sql} ${orgId ? "AND s.org_id = ?" : ""}
  `).bind(who.userId, input.sessionId, input.workspaceId, ...access.bind, ...(orgId ? [orgId] : [])).first<{ attention_json: string | null; state_json: string | null }>()
  if (!row) throw new ClaxedoError({ code: "session_not_found", message: "Session not found or deletion is not authorized", status: 404 })
  const facts = storedSessionAttention(row.attention_json)
  if (!facts) throw new ClaxedoError({ code: "session_attention_unavailable", message: "Session activity is unavailable", status: 503 })
  const reader = storedSessionReader(row.state_json)
  const revision = reader?.generation === facts.generation ? reader.revision : 0
  if (input.generation !== facts.generation || input.readerRevision !== revision) {
    throw new ClaxedoError({ code: "session_cleanup_changed", message: "Session reader state changed after selection", status: 409 })
  }
}
