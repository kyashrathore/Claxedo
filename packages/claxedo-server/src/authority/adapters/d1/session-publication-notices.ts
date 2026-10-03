import type { D1Database } from "@cloudflare/workers-types"
import type { SessionAttentionEvent, SessionRef } from "@claxedo/agent-runtime-contract"
import type { SessionAttentionBatch } from "@claxedo/server-core/platform/auth/session-attention-authority"
import type { SessionStateEvent } from "@claxedo/server-core/platform/runtime/lib/session-state-events"
import { sessionAttentionEventSchema } from "@claxedo/server-core/session/session-publication"
import { readD1SessionStateNotices } from "./session-state-notices"
import { readD1SessionRemovedNotices } from "./session-removed-notices"

type PublishedEvent = SessionRef & { generation: number; event: SessionAttentionEvent }

export async function readD1SessionPublicationNotices(database: D1Database, refs: readonly SessionRef[],
  batches: readonly SessionAttentionBatch[]): Promise<SessionStateEvent[]> {
  const notices = await readD1SessionStateNotices(database, refs)
  const removed = await readD1SessionRemovedNotices(database, refs)
  const published = await publishedEvents(database, batches)
  return [...notices.flatMap(({ recipients, ...notice }) => recipients.flatMap((recipient) => {
    const { attention, status, lastTurn, ...ref } = notice
    const base = { ...ref, ownerUserId: recipient.userId }
    const events: SessionStateEvent[] = [{ ...base, type: "session.status.changed", attention, status,
      ...(lastTurn ? { lastTurn } : {}), ts: status.at }]
    for (const event of published) {
      if (event.sessionId !== ref.sessionId || event.workspaceId !== ref.workspaceId || event.generation !== attention.generation) continue
      events.push({ ...base, type: "session.attention.raised", generation: event.generation, event: event.event, ts: event.event.openedAt })
    }
    return events
  })), ...removed]
}

async function publishedEvents(database: D1Database, batches: readonly SessionAttentionBatch[]): Promise<PublishedEvent[]> {
  const selected = batches.flatMap((batch) => batch.events.map((event) => ({
    sessionId: batch.sessionId, workspaceId: batch.workspaceId, generation: batch.generation,
    sequence: event.sequence, eventJson: JSON.stringify(event),
  })))
  if (!selected.length) return []
  const result = await database.prepare(`SELECT DISTINCT e.ordinal, e.session_id, e.workspace_id, e.generation, e.event_json
    FROM json_each(?) selected JOIN session_attention_events e
      ON e.session_id = json_extract(selected.value, '$.sessionId')
        AND e.generation = json_extract(selected.value, '$.generation')
        AND e.sequence = json_extract(selected.value, '$.sequence')
    WHERE e.workspace_id = json_extract(selected.value, '$.workspaceId')
      AND e.event_json = json_extract(selected.value, '$.eventJson')
    ORDER BY e.ordinal`).bind(JSON.stringify(selected))
    .all<{ session_id: string; workspace_id: string; generation: number; event_json: string }>()
  return result.results.map((row) => ({ sessionId: row.session_id, workspaceId: row.workspace_id,
    generation: row.generation, event: sessionAttentionEventSchema.parse(JSON.parse(row.event_json)) }))
}
