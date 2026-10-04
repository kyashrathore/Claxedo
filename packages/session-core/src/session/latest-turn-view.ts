import { AgentMessagePageError, type AgentMessage, type AgentMessagePage } from "@claxedo/agent-runtime-contract"
import type { SqliteDatabase } from "../sqlite/database"
import { isContiguousTurn, readLatestTurn } from "./turn-evidence"

export type MessageProjectionRow = {
  id: string
  ord: number
  info_json: string
  turn_id: string | null
}

type SurfaceTurnRow = {
  id: string
  ord: number
  role: string
  info_id: string | null
  parent_id: string | null
}

/**
 * A session's newest turn whose prompts were projected before `endOrd`, as a
 * semantic page: `latest-turn` is the turn whole, `latest-surface` its prompts
 * and its final message. A turn whose projected rows are not one whole turn
 * is refused rather than paged as one.
 */
export function readLatestTurnView(
  db: SqliteDatabase,
  sessionId: string,
  view: "latest-turn" | "latest-surface",
  endOrd: number | undefined,
  page: {
    hydrate: (rows: MessageProjectionRow[]) => AgentMessage[]
    hydrateSurface: (rows: MessageProjectionRow[]) => AgentMessage[]
    cursorAt: (ord: number) => string
  },
): AgentMessagePage {
  const latest = readLatestTurn(db, sessionId, endOrd)
  if (!latest && endOrd !== undefined) return { messages: [] }
  if (!latest) {
    throw new AgentMessagePageError(409, `Latest turn boundary is unavailable for session: ${sessionId}`)
  }
  const { boundary, prompts } = latest
  const owned = [...prompts]
  const ownedList = owned.map(() => "?").join(", ")
  if (view === "latest-surface") {
    const boundaryInfo = db
      .prepare<Pick<SurfaceTurnRow, "info_id">>(
        `
        SELECT json_extract(info_json, '$.id') AS info_id
        FROM message
        WHERE session_id = ? AND ord = ?
      `,
      )
      .get(sessionId, boundary.ord)
    if (boundaryInfo?.info_id !== boundary.id) {
      throw new AgentMessagePageError(409, `Latest turn projection is not contiguous for session: ${sessionId}`)
    }
    const final = db
      .prepare<SurfaceTurnRow>(
        `
        SELECT
          id,
          ord,
          role,
          json_extract(info_json, '$.id') AS info_id,
          json_extract(info_json, '$.parentID') AS parent_id
        FROM message
        WHERE session_id = ? AND ord >= ?
        ORDER BY ord DESC
        LIMIT 1
      `,
      )
      .get(sessionId, boundary.ord)
    const invalidAssistant = db
      .prepare<{ present: number }>(
        `
        SELECT 1 AS present
        FROM message
        WHERE session_id = ?
          AND ord > ?
          AND NOT (
            json_extract(info_json, '$.id') IS id
            AND (
              (role IS 'user' AND id IN (${ownedList}))
              OR (role IS 'assistant' AND COALESCE(json_extract(info_json, '$.parentID'), '') IN (${ownedList}))
            )
          )
        LIMIT 1
      `,
      )
      .get(sessionId, boundary.ord, ...owned, ...owned)
    if (!final || invalidAssistant) {
      throw new AgentMessagePageError(409, `Latest turn projection is not contiguous for session: ${sessionId}`)
    }
    const selected = db
      .prepare<MessageProjectionRow>(
        `
        SELECT id, ord, info_json, turn_id
        FROM message
        WHERE session_id = ? AND ord >= ? AND (id IN (${ownedList}) OR id = ?)
        ORDER BY ord ASC
      `,
      )
      .all(sessionId, boundary.ord, ...owned, final.id)
    const older = db
      .prepare<{ present: number }>("SELECT 1 AS present FROM message WHERE session_id = ? AND ord < ? LIMIT 1")
      .get(sessionId, boundary.ord)
    const intermediate = db
      .prepare<{ present: number }>("SELECT 1 AS present FROM message WHERE session_id = ? AND ord > ? AND ord < ? LIMIT 1")
      .get(sessionId, boundary.ord, final.ord)
    return {
      messages: page.hydrateSurface(selected),
      ...(older || intermediate ? { nextCursor: page.cursorAt(final.ord) } : {}),
    }
  }
  const turn = db
    .prepare<MessageProjectionRow>(
      `
      SELECT id, ord, info_json, turn_id
      FROM message
      WHERE session_id = ? AND ord >= ?${endOrd === undefined ? "" : " AND ord < ?"}
      ORDER BY ord ASC
    `,
    )
    .all(...(endOrd === undefined ? [sessionId, boundary.ord] : [sessionId, boundary.ord, endOrd]))
  if (!isContiguousTurn(turn, prompts)) {
    throw new AgentMessagePageError(409, `Latest turn projection is not contiguous for session: ${sessionId}`)
  }
  const older = db
    .prepare<{ present: number }>("SELECT 1 AS present FROM message WHERE session_id = ? AND ord < ? LIMIT 1")
    .get(sessionId, boundary.ord)
  return {
    messages: page.hydrate(turn),
    ...(older ? { nextCursor: page.cursorAt(boundary.ord) } : {}),
  }
}
