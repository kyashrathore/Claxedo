import { batch, createMemo, createSignal, type Accessor } from "solid-js"
import type { Subagent } from "@/server"
import { mergeSubagent, type SessionSubagent } from "./subagent-merge"

export type SessionSubagentsStore = {
  readonly list: Accessor<readonly SessionSubagent[]>
  readonly read: (rows: readonly Subagent[]) => void
  readonly apply: (update: Subagent) => void
}

export function createSessionSubagents(): SessionSubagentsStore {
  const [entries, setEntries] = createSignal<ReadonlyMap<string, SessionSubagent>>(new Map())
  const apply = (update: Subagent) =>
    setEntries((current) => new Map(current).set(update.subagentKey, mergeSubagent(current.get(update.subagentKey), update)))
  const sorted = createMemo(() => [...entries().values()].sort((a, b) => a.subagentKey.localeCompare(b.subagentKey)))
  return {
    list: sorted,
    read: (rows) => batch(() => rows.forEach(apply)),
    apply,
  }
}
