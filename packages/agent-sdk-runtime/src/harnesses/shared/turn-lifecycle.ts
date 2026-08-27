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
  const busyGenerations = new Map<string, object>()
  const activeTurns = new Map<string, T>()
  const idleWaiters = new Map<string, Set<() => void>>()

  const settleIdle = (sessionId: string) => {
    const waiters = idleWaiters.get(sessionId)
    if (!waiters) return
    idleWaiters.delete(sessionId)
    for (const resolve of waiters) resolve()
  }

  return {
    busySessions,
    activeTurns,
    enter(sessionId: string) {
      if (busyGenerations.has(sessionId)) return null
      const generation = {}
      busyGenerations.set(sessionId, generation)
      busySessions.add(sessionId)
      return () => {
        if (busyGenerations.get(sessionId) !== generation) return
        busyGenerations.delete(sessionId)
        busySessions.delete(sessionId)
        settleIdle(sessionId)
      }
    },
    whenIdle(sessionId: string) {
      if (!busyGenerations.has(sessionId)) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const waiters = idleWaiters.get(sessionId) ?? new Set<() => void>()
        waiters.add(resolve)
        idleWaiters.set(sessionId, waiters)
      })
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
      busyGenerations.clear()
      busySessions.clear()
      activeTurns.clear()
      for (const sessionId of idleWaiters.keys()) settleIdle(sessionId)
    },
  }
}

export type SessionTurnLifecycle<T extends TrackedTurn> = ReturnType<typeof createSessionTurnLifecycle<T>>
