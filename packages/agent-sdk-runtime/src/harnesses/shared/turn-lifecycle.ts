export type TrackedTurn = {
  abort?: AbortController
  close?: () => void
  drain?: (message: string) => void
  turnId?: string
}

// An intentional stop is a cancelled outcome. Teardown paths use abortAll()
// without this marker so process loss still surfaces as a real turn failure.
export const EXPLICIT_TURN_ABORT_REASON = Symbol("explicit-turn-abort")

export function createSessionTurnLifecycle<T extends TrackedTurn>() {
  const busySessions = new Set<string>()
  const activeTurns = new Map<string, T>()

  return {
    busySessions,
    activeTurns,
    enter(sessionId: string) {
      if (busySessions.has(sessionId)) return null
      busySessions.add(sessionId)
      return () => busySessions.delete(sessionId)
    },
    get(sessionId: string) {
      return activeTurns.get(sessionId)
    },
    set(sessionId: string, turn: T) {
      activeTurns.set(sessionId, turn)
    },
    delete(sessionId: string, turn?: T) {
      if (turn && activeTurns.get(sessionId) !== turn) return
      activeTurns.delete(sessionId)
    },
    drain(sessionId: string, message: string) {
      activeTurns.get(sessionId)?.drain?.(message)
    },
    drainAll(message: string) {
      for (const turn of activeTurns.values()) turn.drain?.(message)
    },
    abort(sessionId: string) {
      const turn = activeTurns.get(sessionId)
      if (!turn) return false
      turn.abort?.abort(EXPLICIT_TURN_ABORT_REASON)
      turn.close?.()
      return true
    },
    abortAll() {
      for (const turn of activeTurns.values()) {
        turn.abort?.abort()
        turn.close?.()
      }
      activeTurns.clear()
    },
    clear() {
      busySessions.clear()
      activeTurns.clear()
    },
  }
}

export type SessionTurnLifecycle<T extends TrackedTurn> = ReturnType<typeof createSessionTurnLifecycle<T>>
