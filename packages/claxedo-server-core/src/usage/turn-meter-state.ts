import type { RuntimeTokenUsage } from "@claxedo/agent-event-runtime"
import { isJsonRecord } from "../platform/runtime/lib/json"
import { readTurnUsageTokens } from "./contracts"

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

/**
 * A stored state read back, or nothing when any part of it is not one. A
 * partial state is worse than none: the meter falls back to the fact's sum,
 * where half the streams would under-count every scope that went missing.
 */
export function readTurnMeterState(streams: unknown, lastObservationKeys: unknown): TurnMeterState | undefined {
  if (!isJsonRecord(streams) || !isJsonRecord(lastObservationKeys)) return undefined
  const state: TurnMeterState = { streams: {}, lastObservationKeys: {} }
  for (const [scope, value] of Object.entries(streams)) {
    const tokens = readTurnUsageTokens(value)
    if (!tokens) return undefined
    state.streams[scope] = tokens
  }
  for (const [scope, value] of Object.entries(lastObservationKeys)) {
    if (typeof value !== "string") return undefined
    state.lastObservationKeys[scope] = value
  }
  return state
}
