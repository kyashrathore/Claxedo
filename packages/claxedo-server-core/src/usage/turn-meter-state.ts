import type { RuntimeTokenUsage } from "@claxedo/agent-event-runtime"

/**
 * A turn's running usage per scope and the last observation each scope
 * applied. It is the meter's own bookkeeping, kept outside the fact and its
 * payload hash: a fact stores only the sum, and a turn restored from the sum
 * alone cannot tell which scope a later cumulative replaces.
 */
export type TurnMeterState = {
  streams: Record<string, RuntimeTokenUsage>
  lastObservationKeys: Record<string, string>
}

export type TurnMeterStateStore = {
  load(input: { sessionId: string; messageId: string }): Promise<TurnMeterState | undefined>
  save(input: { sessionId: string; messageId: string; state: TurnMeterState }): Promise<void>
}
