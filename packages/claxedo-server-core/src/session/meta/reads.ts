import { ClaxedoDB, numberColumn, queryRow } from "../../platform/db"
import { controlBus } from "../../platform/runtime/lib/bus"
import { sessionReaderState, type SessionReaderState, type SessionReaderWrite } from "../reader"
import { sessionMeta } from "./index"

const SEEN_SQL = `
  INSERT INTO claxedo_session_reads (user_id, session_ref, seen_at) VALUES (?, ?, ?)
  ON CONFLICT (user_id, session_ref) DO UPDATE SET seen_at = max(coalesce(seen_at, 0), excluded.seen_at)
  RETURNING seen_at, settled_at`

/**
 * Settles through the session's own last activity, the runtime timestamps the
 * list compares `settled_at` with, so whether a later send or turn result
 * un-settles it is decided on the runtime's clock alone.
 */
const SETTLE_SQL = `
  INSERT INTO claxedo_session_reads (user_id, session_ref, settled_at)
  SELECT ?, m.session_ref, max(coalesce(m.last_human_turn_at, 0), coalesce(m.last_turn_completed_at, 0))
  FROM claxedo_session_meta m WHERE m.session_ref = ?
  ON CONFLICT (user_id, session_ref) DO UPDATE SET settled_at = excluded.settled_at
  RETURNING seen_at, settled_at`

const UNSETTLE_SQL = `
  INSERT INTO claxedo_session_reads (user_id, session_ref, settled_at) VALUES (?, ?, NULL)
  ON CONFLICT (user_id, session_ref) DO UPDATE SET settled_at = NULL
  RETURNING seen_at, settled_at`

function upsertFor(write: SessionReaderWrite, userId: string, sessionRef: string): [string, ...unknown[]] {
  if ("seenThrough" in write) return [SEEN_SQL, userId, sessionRef, write.seenThrough]
  return write.settled ? [SETTLE_SQL, userId, sessionRef] : [UNSETTLE_SQL, userId, sessionRef]
}

/** The reader's marks after the write; nothing when no session by that id is stored here. */
export async function writeSessionReader(userId: string, sessionID: string, write: SessionReaderWrite): Promise<SessionReaderState | undefined> {
  const meta = await sessionMeta(sessionID)
  if (!meta?.sessionRef) return undefined
  const [sql, ...params] = upsertFor(write, userId, meta.sessionRef)
  const row = queryRow(ClaxedoDB.raw(), sql, ...params) ?? {}
  const state = sessionReaderState(numberColumn(row, "seen_at"), numberColumn(row, "settled_at"))
  if (meta.workspaceID) {
    controlBus.publish({ type: "session.reader.changed", ownerUserId: userId, sessionId: sessionID, workspaceId: meta.workspaceID, ...state, ts: Date.now() })
  }
  return state
}
