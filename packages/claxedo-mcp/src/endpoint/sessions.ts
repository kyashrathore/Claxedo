export type McpSessionRecord<Session> = Readonly<{
  session: Session
  /** The credential that initialized the session; a request under another credential does not see it. */
  credentialKey: string
  close: () => Promise<void>
}>

export type McpSessionStoreOptions = Readonly<{
  maxSessions: number
  idleMs: number
  now?: () => number
}>

/**
 * The MCP sessions one process holds, ordered by last use.
 *
 * Streamable HTTP keeps server state per `Mcp-Session-Id`, and elicitation
 * needs that state: the client's answer arrives on a later request and must
 * reach the server that asked. The map is bounded and idle entries expire,
 * so a client that never sends DELETE cannot pin memory; a session evicted
 * under a live client answers 404, which the transport spec defines as
 * "initialize again".
 */
export function createMcpSessionStore<Session>(options: McpSessionStoreOptions) {
  const now = options.now ?? Date.now
  const records = new Map<string, McpSessionRecord<Session> & { lastSeenAt: number }>()

  const evict = (id: string) => {
    const record = records.get(id)
    if (!record) return
    records.delete(id)
    void record.close().catch(() => undefined)
  }

  const sweep = () => {
    const deadline = now() - options.idleMs
    for (const [id, record] of records) {
      if (record.lastSeenAt > deadline) break
      evict(id)
    }
  }

  return {
    get size() {
      return records.size
    },
    /** The session for `id` under `credentialKey`, marking it used; undefined when unknown, expired, or another credential's. */
    get(id: string, credentialKey: string): Session | undefined {
      sweep()
      const record = records.get(id)
      if (!record || record.credentialKey !== credentialKey) return undefined
      records.delete(id)
      records.set(id, { ...record, lastSeenAt: now() })
      return record.session
    },
    add(id: string, record: McpSessionRecord<Session>) {
      sweep()
      while (records.size >= options.maxSessions) {
        const oldest = records.keys().next()
        if (oldest.done) break
        evict(oldest.value)
      }
      records.set(id, { ...record, lastSeenAt: now() })
    },
    remove(id: string) {
      records.delete(id)
    },
    /** Close every live session; the mount's owner calls it when the process or the runtime it serves goes away. */
    closeAll() {
      // A snapshot: `evict` deletes from the map being walked.
      const live = [...records.keys()]
      for (const id of live) evict(id)
    },
  }
}

export type McpSessionStore<Session> = ReturnType<typeof createMcpSessionStore<Session>>
