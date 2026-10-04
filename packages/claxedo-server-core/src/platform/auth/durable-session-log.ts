export type DurableSessionLog = {
  persist_message_event: (sessionID: string, event: { type: string; properties?: unknown }) => void
}

// Backend contract = the port itself; adapters supply the implementation.
export type DurableSessionLogBackend = DurableSessionLog

export function createDurableSessionLog(sync: DurableSessionLogBackend): DurableSessionLog {
  return {
    persist_message_event: sync.persist_message_event,
  }
}
