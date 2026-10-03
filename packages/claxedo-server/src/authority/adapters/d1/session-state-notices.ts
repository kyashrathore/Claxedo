import type { D1Database } from "@cloudflare/workers-types"
import type { SessionRef } from "@claxedo/agent-runtime-contract"
import { parseAgentTurnOutcome } from "@claxedo/agent-runtime-contract"
import type { SessionStateNotice } from "@claxedo/server-core/platform/auth/session-attention-authority"
import { storedSessionAttention } from "@claxedo/server-core/session/reader-contract"
import { sessionNoticeReadersSql } from "./session-notice-readers"

type NoticeRow = {
  session_id: string
  workspace_id: string
  org_id: string
  project_id: string
  title: string | null
  attention_json: string
  last_turn_json: string | null
  status: "idle" | "busy" | "retry" | "interrupted"
  status_at: number
  awaiting_input: number
  user_id: string
}

export async function readD1SessionStateNotices(database: D1Database, refs: readonly SessionRef[]): Promise<SessionStateNotice[]> {
  if (!refs.length) return []
  const result = await database.prepare(`
    SELECT s.session_id, s.workspace_id, s.org_id, s.project_id, s.title, s.attention_json, s.last_turn_json,
      s.status, s.status_at, s.awaiting_input, recipient.user_id
    ${sessionNoticeReadersSql("read")}
      AND s.attention_json IS NOT NULL AND s.status IS NOT NULL AND s.status_at IS NOT NULL
    ORDER BY s.session_id, recipient.user_id
  `).bind(JSON.stringify(refs)).all<NoticeRow>()
  const notices = new Map<string, SessionStateNotice>()
  for (const row of result.results) {
    let notice = notices.get(row.session_id)
    if (!notice) {
      notice = noticeRow(row)
      notices.set(row.session_id, notice)
    }
    if (!notice.recipients.some((recipient) => recipient.userId === row.user_id)) {
      notice.recipients.push({ userId: row.user_id })
    }
  }
  return [...notices.values()]
}

function noticeRow(row: NoticeRow): SessionStateNotice {
  const attention = storedSessionAttention(row.attention_json)!
  const lastTurn = parseAgentTurnOutcome(row.last_turn_json === null ? undefined : JSON.parse(row.last_turn_json))
  return {
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    orgId: row.org_id,
    projectId: row.project_id,
    ...(row.title === null ? {} : { title: row.title }),
    attention,
    ...(lastTurn ? { lastTurn } : {}),
    status: { kind: row.status, awaitingInput: row.awaiting_input === 1, at: row.status_at },
    recipients: [],
  }
}
