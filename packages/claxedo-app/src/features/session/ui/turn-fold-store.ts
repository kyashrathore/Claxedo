import { createStore } from "solid-js/store"

/**
 * Session-scoped, per-turn fold persistence (T0.3). Mirrors the `toolOpen` half of
 * `timelineCache` in message-timeline.tsx: a module-level Map keyed by session with
 * a max-16 eviction so fold state survives pane remount and session switching.
 *
 * A value of `undefined` means "auto" — the auto-fold heuristic (T5) decides; an
 * explicit user toggle (`true`/`false`) always wins over auto.
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
  const [state, setState] = createStore<FoldState>({ ...(turnFoldCache.get(sessionKey) ?? {}) })

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
