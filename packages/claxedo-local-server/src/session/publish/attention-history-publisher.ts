import type { HostSessionRow, SessionAttentionPublication } from "@claxedo/server-core/platform/auth/host-session-rows"
import type { SessionRowSource } from "./local-session-rows"

type PublishedPosition = { generation: number; through: number }

export function createAttentionHistoryPublisher(source: Pick<SessionRowSource, "attentionPage">) {
  const positions = new Map<string, PublishedPosition>()
  const keyOf = (workspaceId: string, sessionId: string) => `${workspaceId}/${sessionId}`
  return {
    async read(row: HostSessionRow): Promise<SessionAttentionPublication[]> {
      if (!row.attention) throw new Error(`Session ${row.sessionId} has no canonical attention position`)
      const held = positions.get(keyOf(row.workspaceId, row.sessionId))
      let after = held?.generation === row.attention.generation ? held.through : 0
      if (after >= row.attention.sequence) return []
      const batches: SessionAttentionPublication[] = []
      while (after < row.attention.sequence) {
        const page = await source.attentionPage(row.workspaceId, row.sessionId, after)
        if (page.generation !== row.attention.generation) throw new Error("Session generation changed while reading attention history")
        const through = Math.min(page.next ?? page.through, row.attention.sequence)
        const events = page.events.filter((event) => event.sequence > after && event.sequence <= through)
        if (through <= after) throw new Error("Session attention history made no progress")
        batches.push({ workspaceId: row.workspaceId, sessionId: row.sessionId, generation: page.generation, through, events })
        after = through
      }
      return batches
    },
    acknowledge(batch: SessionAttentionPublication) {
      const key = keyOf(batch.workspaceId, batch.sessionId)
      const held = positions.get(key)
      if (!held || held.generation !== batch.generation || held.through < batch.through) {
        positions.delete(key)
        positions.set(key, { generation: batch.generation, through: batch.through })
      }
      while (positions.size > 10_000) positions.delete(positions.keys().next().value!)
    },
    forget(workspaceId: string, sessionId: string) { positions.delete(keyOf(workspaceId, sessionId)) },
    reset() { positions.clear() },
  }
}
