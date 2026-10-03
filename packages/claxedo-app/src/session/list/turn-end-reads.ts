import type { SessionLastTurn } from "@claxedo/agent-runtime-contract"
import type { SessionId, SessionLocation } from "@/server"
import { ACTIVITY_WINDOW, type ListState } from "./model"

const REMEMBERED_TURN_ENDS = 500

export type TurnEndNotice = { readonly ref: SessionLocation; readonly lastTurn?: SessionLastTurn; readonly replayed?: boolean }

export type TurnEndReadInput = {
  readonly state: () => ListState
  readonly showSettled: () => boolean
  readonly read: (ref: SessionLocation, lastTurn: SessionLastTurn) => void
}

export function createTurnEndReads(input: TurnEndReadInput): (notice: TurnEndNotice) => void {
  const asked = new Map<SessionId, number>()
  return ({ ref, lastTurn, replayed }) => {
    if (!lastTurn || replayed || input.showSettled()) return
    const state = input.state()
    if (state.entries.has(ref.sessionId) || (!state.windows.has(ref.projectId) && !state.windows.has(ACTIVITY_WINDOW))) return
    if ((asked.get(ref.sessionId) ?? Number.NEGATIVE_INFINITY) >= lastTurn.completedAt) return
    asked.delete(ref.sessionId)
    asked.set(ref.sessionId, lastTurn.completedAt)
    if (asked.size > REMEMBERED_TURN_ENDS) asked.delete(asked.keys().next().value!)
    input.read(ref, lastTurn)
  }
}
