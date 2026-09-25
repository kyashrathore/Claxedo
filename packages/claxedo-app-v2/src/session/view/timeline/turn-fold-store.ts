import { createStore } from "solid-js/store"

type FoldState = Record<string, boolean | undefined>

const turnFoldCache = new Map<string, FoldState>()
const MAX_SESSIONS = 16

export interface TurnFoldStore {
  isFolded(userMessageId: string): boolean | undefined
  setFolded(userMessageId: string, value: boolean): void
  reset(userMessageId: string): void
  persist(): void
}

export function createTurnFoldStore(sessionKey: string): TurnFoldStore {
  const [state, setState] = createStore<FoldState>({ ...turnFoldCache.get(sessionKey) })

  return {
    isFolded(userMessageId) {
      return state[userMessageId]
    },
    setFolded(userMessageId, value) {
      setState(userMessageId, value)
    },
    reset(userMessageId) {
      setState(userMessageId, undefined)
    },
    persist() {
      turnFoldCache.delete(sessionKey)
      turnFoldCache.set(sessionKey, { ...state })
      while (turnFoldCache.size > MAX_SESSIONS) turnFoldCache.delete(turnFoldCache.keys().next().value!)
    },
  }
}
