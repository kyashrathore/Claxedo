import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import type { SessionAttentionEvent, SessionRef } from "@claxedo/agent-runtime-contract"
import type { AccountSessionAttentionPage, SessionAttentionBatch } from "@claxedo/server-core/platform/auth/session-attention-authority"
import { sessionAttentionEventSchema } from "@claxedo/server-core/session/session-publication"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import { maySql, type AuthorizationPrincipal, type BoundSql } from "./authorization"

export function sessionAttentionStatements(database: D1Database, batches: readonly SessionAttentionBatch[],
  admittedRefs: readonly SessionRef[], guard?: BoundSql): D1PreparedStatement[] {
  const admitted = new Set(admittedRefs.map(refKey))
  return batches.filter((batch) => admitted.has(refKey(batch))).flatMap((batch) => batch.events.map((event) => database.prepare(`
    INSERT INTO session_attention_events (session_id, workspace_id, org_id, project_id, generation, sequence, event_json)
    SELECT s.session_id, s.workspace_id, s.org_id, s.project_id, ?, ?, ? FROM sessions s
    WHERE s.session_id = ? AND s.workspace_id = ? AND s.deleted_at IS NULL
      AND json_extract(s.attention_json, '$.generation') = ?
      AND json_extract(s.attention_json, '$.sequence') >= ?
      ${guard ? `AND ${guard.sql}` : ""}
    ON CONFLICT (session_id, generation, sequence) DO UPDATE SET event_json =
      CASE WHEN session_attention_events.event_json = excluded.event_json THEN session_attention_events.event_json ELSE NULL END
  `).bind(batch.generation, event.sequence, JSON.stringify(event), batch.sessionId, batch.workspaceId,
    batch.generation, batch.through, ...(guard?.bind ?? []))))
}

type AttentionRow = {
  ordinal: number
  session_id: string
  workspace_id: string
  project_id: string
  title: string | null
  generation: number
  event_json: string
}

export async function readD1SessionAttention(database: D1Database, who: AuthorizationPrincipal,
  input: { after?: number; limit: number }): Promise<AccountSessionAttentionPage> {
  validatePage(input)
  const access = maySql(who, "read", { kind: "session", alias: "s" })
  const from = `FROM session_attention_events e JOIN sessions s ON s.session_id = e.session_id AND s.workspace_id = e.workspace_id
    WHERE e.generation = json_extract(s.attention_json, '$.generation') AND s.parent_session_id IS NULL
      AND ${access.sql}`
  const highWater = await database.prepare(`SELECT MAX(e.ordinal) AS through ${from}`).bind(...access.bind)
    .first<{ through: number | null }>()
  const after = input.after ?? 0
  const through = Math.max(after, highWater?.through ?? 0)
  const result = await database.prepare(`SELECT e.ordinal, s.session_id, s.workspace_id, s.project_id, s.title,
      e.generation, e.event_json ${from} AND e.ordinal > ? AND e.ordinal <= ? ORDER BY e.ordinal LIMIT ?`)
    .bind(...access.bind, after, through, input.limit + 1).all<AttentionRow>()
  const rows = result.results.slice(0, input.limit)
  return {
    events: rows.map(historyRow),
    through,
    ...(result.results.length > input.limit ? { next: rows.at(-1)!.ordinal } : {}),
  }
}

function validatePage(input: { after?: number; limit: number }) {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 256
    || input.after !== undefined && (!Number.isSafeInteger(input.after) || input.after < 0)) {
    throw new ClaxedoError({ code: "invalid_session_attention_page", message: "Invalid attention history page", status: 400 })
  }
}

function historyRow(row: AttentionRow) {
  const event: SessionAttentionEvent = sessionAttentionEventSchema.parse(JSON.parse(row.event_json))
  return {
    cursor: row.ordinal,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    ...(row.title === null ? {} : { title: row.title }),
    generation: row.generation,
    event,
  }
}

function refKey(ref: SessionRef) {
  return JSON.stringify([ref.workspaceId, ref.sessionId])
}
