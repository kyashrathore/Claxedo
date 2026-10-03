import type { D1Database } from "@cloudflare/workers-types"
import type { SessionRef } from "@claxedo/agent-runtime-contract"
import type { CloudSessionRowsPublisher, CloudSessionRowsResult } from "@claxedo/server-core/platform/auth/cloud-session-rows"
import type { HostSessionRowsPublication } from "@claxedo/server-core/platform/auth/host-session-rows"
import { parseSessionAttention } from "@claxedo/agent-runtime-contract"
import { batchUnder } from "./authorization"
import { cloudSessionRowsFence, cloudSessionRowsPublisherActive } from "./cloud-session-rows-fence"
import { listFieldsStatement, sessionAttentionFieldsStatements } from "./host-session-rows"
import { sessionAttentionStatements } from "./session-attention-history"

type RegisteredSession = { session_id: string; workspace_id: string; deleted_at: number | null; attention_json: string | null }
const key = (ref: SessionRef) => JSON.stringify([ref.workspaceId, ref.sessionId])

/** Cloud producers update only registered sessions; a sandbox cannot adopt a caller-selected session id. */
export async function publishD1CloudSessionRows(database: D1Database, now: number,
  publisher: CloudSessionRowsPublisher, publication: HostSessionRowsPublication): Promise<CloudSessionRowsResult> {
  const touched = [...publication.rows, ...publication.removed, ...(publication.attention ?? [])]
  const refs = [...new Map(touched.map((ref) => [key(ref), ref])).values()]
  const updating = new Set([...publication.rows, ...(publication.attention ?? [])].map(key))
  const removalOnly = new Set(publication.removed.filter((ref) => !updating.has(key(ref))).map(key))
  const result: CloudSessionRowsResult = { accepted: 0, refused: [] }
  const active = await cloudSessionRowsPublisherActive(database, publisher)
  const registered = await registeredSessions(database, refs)
  const refusals = new Map<string, CloudSessionRowsResult["refused"][number]["reason"]>()
  const admitted = refs.filter((ref) => {
    const row = registered.get(ref.sessionId)
    const reason = !active || ref.workspaceId !== publisher.workspaceId ? "workspace_not_served"
      : !row ? "session_unregistered" : row.workspace_id !== ref.workspaceId ? "session_elsewhere"
        : row.deleted_at !== null && !removalOnly.has(key(ref)) ? "session_deleted" : undefined
    const refused = reason ?? (!attentionBoundaryMatches(publication, row!, ref) ? "attention_boundary_changed" : undefined)
    if (refused) refusals.set(key(ref), refused)
    return refused === undefined
  })
  result.refused = touched.flatMap((ref) => {
    const reason = refusals.get(key(ref))
    return reason ? [{ workspaceId: ref.workspaceId, sessionId: ref.sessionId, reason }] : []
  })
  if (!admitted.length) return result
  const accepted = new Set(admitted.map(key))
  const rows = publication.rows.filter((row) => accepted.has(key(row)))
  const removed = publication.removed.filter((ref) => accepted.has(key(ref)))
  const fence = cloudSessionRowsFence(publisher)
  const statements = [
    ...rows.map((row) => listFieldsStatement(database, row, fence)),
    ...rows.flatMap((row) => sessionAttentionFieldsStatements(database, row, fence, { hostId: publisher.hostId, generation: publisher.epoch })),
    ...sessionAttentionStatements(database, publication.attention ?? [], admitted, fence),
    ...removed.map((ref) => database.prepare(`UPDATE sessions SET deleted_at = ?
      WHERE session_id = ? AND workspace_id = ? AND deleted_at IS NULL AND ${fence.sql}`)
      .bind(now, ref.sessionId, ref.workspaceId, ...fence.bind)),
  ]
  // Removal retries retain the committed tombstone; updates and history still require a live session.
  const sessionsRegistered = `NOT EXISTS (SELECT 1 FROM json_each(?) selected
    WHERE NOT EXISTS (SELECT 1 FROM sessions registered
      WHERE registered.session_id = json_extract(selected.value, '$.sessionId')
        AND registered.workspace_id = json_extract(selected.value, '$.workspaceId')
        AND (json_extract(selected.value, '$.removalOnly') = 1 OR registered.deleted_at IS NULL)))`
  if (statements.length) await batchUnder(database, {
    sql: `${fence.sql} AND ${sessionsRegistered}`,
    bind: [...fence.bind, JSON.stringify(admitted.map((ref) => ({
      workspaceId: ref.workspaceId, sessionId: ref.sessionId, removalOnly: removalOnly.has(key(ref)),
    })))],
  }, statements)
  result.accepted = touched.length - result.refused.length
  return result
}

async function registeredSessions(database: D1Database, refs: readonly SessionRef[]) {
  const ids = [...new Set(refs.map((ref) => ref.sessionId))]
  if (!ids.length) return new Map<string, RegisteredSession>()
  const rows = await database.prepare(`SELECT session_id, workspace_id, deleted_at, attention_json FROM sessions
    WHERE session_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all<RegisteredSession>()
  return new Map(rows.results.map((row) => [row.session_id, row]))
}

function attentionBoundaryMatches(publication: HostSessionRowsPublication, held: RegisteredSession, ref: SessionRef) {
  const batches = publication.attention?.filter((batch) => key(batch) === key(ref)) ?? []
  if (!batches.length) return true
  const previous = held.attention_json ? parseSessionAttention(JSON.parse(held.attention_json)) : undefined
  const incoming = publication.rows.filter((row) => key(row) === key(ref) && row.attention)
    .map((row) => row.attention!).sort((left, right) => right.sequence - left.sequence)[0]
  const facts = incoming && (!previous || incoming.sequence >= previous.sequence) ? incoming : previous
  return facts !== undefined && batches.every((batch) => facts.generation === batch.generation && facts.sequence >= batch.through)
}
