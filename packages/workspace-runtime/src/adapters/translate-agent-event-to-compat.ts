import type { AgentEvent } from "./index"
import { translateChunkToEvent, type ChunkToEventContext } from "./translate-chunk-to-event"

export function translateAgentEventToCompat(event: AgentEvent, ctx: ChunkToEventContext) {
  return translateChunkToEvent(event, ctx)
}
