import { batch, createMemo, createSignal, type Accessor } from "solid-js"
import type { Server, SessionRef, Subagent } from "@/server"
import { mergeSubagent, type SessionSubagent } from "./subagent-merge"

export type SessionSubagentsStore = {
  readonly list: Accessor<readonly SessionSubagent[]>
  readonly reread: () => void
  readonly apply: (update: Subagent) => void
}

export function createSessionSubagents(server: Server, ref: SessionRef): SessionSubagentsStore {
  const [entries, setEntries] = createSignal<ReadonlyMap<string, SessionSubagent>>(new Map())
  const apply = (update: Subagent) =>
    setEntries((current) => new Map(current).set(update.subagentKey, mergeSubagent(current.get(update.subagentKey), update)))
  const read = async () => {
    try {
      const rows = await server.sessions.subagents(ref)
      batch(() => rows.forEach(apply))
    } catch (error) {
      console.warn("A session's subagents could not be read", { sessionId: ref.sessionId, error })
    }
  }
  const sorted = createMemo(() => [...entries().values()].sort((a, b) => a.subagentKey.localeCompare(b.subagentKey)))
  let wanted = false
  return {
    list: () => {
      if (!wanted) {
        wanted = true
        void read()
      }
      return sorted()
    },
    reread: () => {
      if (wanted) void read()
    },
    apply,
  }
}
