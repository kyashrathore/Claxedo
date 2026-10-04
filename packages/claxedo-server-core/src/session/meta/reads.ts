import { ClaxedoDB, numberColumn, queryRow } from "../../platform/db"
import { controlBus } from "../../platform/runtime/lib/bus"
import { sessionReaderState, type SessionReaderState, type SessionReaderWrite } from "../reader"
import { sessionMeta } from "./index"

/**
 * A seen mark is capped at the later of the session's recorded last turn end
 * and this server's clock: the cap keeps a future timestamp from hiding every
 * later dot, and the clock admits a turn end the reader heard before this
 * store recorded it.
 */
const SEEN_SQL = `
  INSERT INTO claxedo_session_reads (user_id, session_ref, seen_at)
  SELECT ?, m.session_ref, min(?, max(coalesce(m.last_turn_completed_at, 0), ?))
  FROM claxedo_session_meta m WHERE m.session_ref = ?
  ON CONFLICT (user_id, session_ref) DO UPDATE SET seen_at = max(coalesce(seen_at, 0), excluded.seen_at)
  RETURNING seen_at, settled_at`

/**
 * `settled_at` is a runtime timestamp, like the activity the list compares it
 * with: the later of the activity the reader saw and the activity recorded
 * here, so a turn the reader settled past is never newer than the settle.
 */
const SETTLE_SQL = `
  INSERT INTO claxedo_session_reads (user_id, session_ref, settled_at)
  SELECT ?, m.session_ref, max(?, coalesce(m.last_human_turn_at, 0), coalesce(m.last_turn_completed_at, 0))
  FROM claxedo_session_meta m WHERE m.session_ref = ?
  ON CONFLICT (user_id, session_ref) DO UPDATE SET settled_at = excluded.settled_at
  RETURNING seen_at, settled_at`

const UNSETTLE_SQL = `
  INSERT INTO claxedo_session_reads (user_id, session_ref, settled_at) VALUES (?, ?, NULL)
  ON CONFLICT (user_id, session_ref) DO UPDATE SET settled_at = NULL
  RETURNING seen_at, settled_at`

function upsertFor(write: SessionReaderWrite, userId: string, sessionRef: string, now: number): [string, ...unknown[]] {
  if ("seenThrough" in write) return [SEEN_SQL, userId, write.seenThrough, now, sessionRef]
  return write.settled ? [SETTLE_SQL, userId, write.through, sessionRef] : [UNSETTLE_SQL, userId, sessionRef]
}

/** The reader's marks after the write; nothing when no session by that id is stored here. */
export async function writeSessionReader(userId: string, sessionID: string, write: SessionReaderWrite, now = Date.now()): Promise<SessionReaderState | undefined> {
  const meta = await sessionMeta(sessionID)
  if (!meta?.sessionRef) return undefined
  const [sql, ...params] = upsertFor(write, userId, meta.sessionRef, now)
  const row = queryRow(ClaxedoDB.raw(), sql, ...params) ?? {}
  const state = sessionReaderState(numberColumn(row, "seen_at"), numberColumn(row, "settled_at"))
  if (meta.workspaceID) {
    controlBus.publish({ type: "session.reader.changed", ownerUserId: userId, sessionId: sessionID, workspaceId: meta.workspaceID, ...state, ts: now })
  }
  return state
}
