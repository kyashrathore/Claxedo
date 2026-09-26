import type { SubagentMode, SubagentStatus, SubagentToolCallRole, SubagentTranscript } from "@claxedo/agent-runtime-contract"
import type { Subagent } from "@/server"

export type SessionSubagent = {
  readonly subagentKey: string
  readonly mode?: SubagentMode
  readonly status?: SubagentStatus
  readonly label?: string
  readonly subagentType?: string
  readonly description?: string
  readonly providerId?: string
  readonly providerKind?: string
  readonly childSessionId?: string
  readonly transcript?: SubagentTranscript
  readonly toolCallEdges: ReadonlyMap<string, SubagentToolCallRole>
  readonly revisions: Readonly<Record<string, number>>
}

const LATEST_WINS = ["mode", "label", "subagentType", "description", "transcript"] as const
const FIRST_WINS = ["providerId", "providerKind", "childSessionId"] as const
const TERMINAL: ReadonlySet<SubagentStatus> = new Set<SubagentStatus>(["completed", "failed", "killed", "interrupted"])

type Field = (typeof LATEST_WINS)[number] | (typeof FIRST_WINS)[number] | "status"

function withField<K extends Field>(entry: SessionSubagent, field: K, value: SessionSubagent[K], revision: number): SessionSubagent {
  return { ...entry, [field]: value, revisions: { ...entry.revisions, [field]: Math.max(entry.revisions[field] ?? 0, revision) } }
}

function mergeFields(entry: SessionSubagent, update: Subagent): SessionSubagent {
  let next = entry
  for (const field of LATEST_WINS) {
    const value = update[field]
    if (value !== undefined && update.revision > (next.revisions[field] ?? 0)) next = withField(next, field, value, update.revision)
  }
  for (const field of FIRST_WINS) {
    const value = update[field]
    if (value !== undefined && next[field] === undefined) next = withField(next, field, value, update.revision)
  }
  return next
}

function mergeStatus(entry: SessionSubagent, update: Subagent): SessionSubagent {
  const status = update.status
  if (status === undefined) return entry
  const settled = entry.status !== undefined && TERMINAL.has(entry.status)
  if (settled && !TERMINAL.has(status)) return entry
  if (TERMINAL.has(status) && !settled) return withField(entry, "status", status, update.revision)
  return update.revision > (entry.revisions.status ?? 0) ? withField(entry, "status", status, update.revision) : entry
}

function mergeEdge(entry: SessionSubagent, update: Subagent): SessionSubagent {
  if (!update.toolCallId || !update.toolCallRole || entry.toolCallEdges.has(update.toolCallId)) return entry
  const edges = new Map(entry.toolCallEdges)
  edges.set(update.toolCallId, update.toolCallRole)
  return { ...entry, toolCallEdges: edges }
}

export function mergeSubagent(entry: SessionSubagent | undefined, update: Subagent): SessionSubagent {
  const base: SessionSubagent = entry ?? { subagentKey: update.subagentKey, toolCallEdges: new Map(), revisions: {} }
  return mergeEdge(mergeStatus(mergeFields(base, update), update), update)
}
