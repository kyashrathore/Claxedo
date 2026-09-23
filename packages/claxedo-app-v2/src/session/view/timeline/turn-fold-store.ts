import { createStore } from "solid-js/store"

/**
 * The reader's own fold choices, per turn, kept for 16 sessions so they survive
 * pane remount and session switching.
 *
 * `undefined` leaves a turn on auto, where the row builder decides from the
 * turn's own state; an explicit choice always beats that decision.
 */
type FoldState = Record<string, boolean | undefined>

const turnFoldCache = new Map<string, FoldState>()
const MAX_SESSIONS = 16

export interface TurnFoldStore {
  /** Explicit user choice for a turn, or `undefined` when still on auto. */
  isFolded(userMessageID: string): boolean | undefined
  /** Record an explicit user toggle. */
  setFolded(userMessageID: string, value: boolean): void
  /** Reset a turn back to auto. */
  reset(userMessageID: string): void
  /** Write the current state back to the module cache (call from onCleanup). */
  persist(): void
}

export function createTurnFoldStore(sessionKey: string): TurnFoldStore {
  const [state, setState] = createStore<FoldState>({ ...turnFoldCache.get(sessionKey) })

  return {
    isFolded(userMessageID) {
      return state[userMessageID]
    },
    setFolded(userMessageID, value) {
      setState(userMessageID, value)
    },
    reset(userMessageID) {
      setState(userMessageID, undefined)
    },
    persist() {
      turnFoldCache.delete(sessionKey)
      turnFoldCache.set(sessionKey, { ...state })
      while (turnFoldCache.size > MAX_SESSIONS) turnFoldCache.delete(turnFoldCache.keys().next().value!)
    },
  }
}
