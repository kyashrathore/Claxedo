import { createStore } from "solid-js/store"

type FoldState = Record<string, boolean | undefined>

const turnFoldCache = new Map<string, FoldState>()
const MAX_SESSIONS = 16

export interface TurnFoldStore {
  isFolded(userMessageID: string): boolean | undefined
  setFolded(userMessageID: string, value: boolean): void
  reset(userMessageID: string): void
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
