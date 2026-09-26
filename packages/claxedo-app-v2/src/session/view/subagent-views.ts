import type { SessionSubagent } from "@/session"
import type { SubagentView } from "@/transcript"

export type SubagentLabels = { readonly subagent: string; readonly task: string }

const STATUSES: ReadonlySet<string> = new Set(["pending", "running", "paused", "interrupted", "completed", "failed", "killed"])
const TRANSCRIPTS: ReadonlySet<string> = new Set(["live", "file", "messages", "none"])

function statusOf(entry: SessionSubagent): SubagentView["status"] {
  return entry.status && STATUSES.has(entry.status) ? entry.status : "unknown"
}

function isTranscriptKind(kind: string | undefined): kind is Exclude<SubagentView["transcriptKind"], "unknown"> {
  return kind !== undefined && TRANSCRIPTS.has(kind)
}

function transcriptOf(entry: SessionSubagent): SubagentView["transcriptKind"] {
  const kind = entry.transcript?.kind
  return isTranscriptKind(kind) ? kind : "unknown"
}

function resolutionOf(entry: SessionSubagent, kind: SubagentView["transcriptKind"]): SubagentView["resolution"] {
  if (kind === "none") return "unavailable"
  if (entry.childSessionId) return "ready"
  return kind === "live" || kind === "file" || kind === "messages" ? "not-yet-bound" : "unavailable"
}

function ambientOf(entry: SessionSubagent, hostableCallIds: ReadonlySet<string> | undefined, historyComplete: boolean): boolean {
  if (entry.toolCallEdges.size === 0) return true
  if (hostableCallIds === undefined || !historyComplete) return false
  return ![...entry.toolCallEdges.keys()].some((id) => hostableCallIds.has(id))
}

type ViewContext = {
  readonly parentSessionId: string
  readonly labels: SubagentLabels
  readonly toolCallId?: string
  readonly hostableCallIds?: ReadonlySet<string>
  readonly historyComplete: boolean
}

function subagentView(entry: SessionSubagent, context: ViewContext): SubagentView {
  const { parentSessionId, labels, toolCallId, hostableCallIds } = context
  const transcriptKind = transcriptOf(entry)
  const role = toolCallId ? entry.toolCallEdges.get(toolCallId) : undefined
  return {
    parentSessionId,
    subagentKey: entry.subagentKey,
    ...(role ? { toolCallRole: role } : {}),
    ...(entry.mode ? { mode: entry.mode } : {}),
    status: statusOf(entry),
    label: entry.label || labels.subagent,
    agentLabel: entry.subagentType || entry.providerKind || labels.subagent,
    description: entry.description || labels.task,
    ...(entry.childSessionId ? { childSessionId: entry.childSessionId } : {}),
    transcriptKind,
    resolution: resolutionOf(entry, transcriptKind),
    ambient: ambientOf(entry, hostableCallIds, context.historyComplete),
  }
}

export function subagentViews(input: ViewContext & { readonly entries: readonly SessionSubagent[] }): SubagentView[] {
  return input.entries
    .filter((entry) => input.toolCallId === undefined || entry.toolCallEdges.has(input.toolCallId))
    .map((entry) => subagentView(entry, input))
}
