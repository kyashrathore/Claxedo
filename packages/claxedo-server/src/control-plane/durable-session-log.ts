import type { SyncDB } from "../sync-db"

export type DurableSessionLog = {
  persist_message_event: (sessionID: string, event: { type: string; properties?: unknown }) => void
  subscribe_message_replay: (bus: {
    subscribe: (fn: (event: { directory?: string; payload: { type: string; properties?: Record<string, unknown> } }) => void) => () => void
  }) => () => void
}

export function createDurableSessionLog(sync: SyncDB): DurableSessionLog {
  return {
    persist_message_event: sync.persist_message_event,
    subscribe_message_replay: sync.subscribe_message_replay,
  }
}
