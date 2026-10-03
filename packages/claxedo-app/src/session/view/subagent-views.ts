import { isSubagentStatus, isSubagentTranscriptKind } from "@claxedo/agent-runtime-contract"
import type { SessionSubagent } from "@/session"
import type { SubagentView } from "@/transcript"

export type SubagentLabels = { readonly subagent: string; readonly task: string }

function subagentViewStatus(entry: SessionSubagent): SubagentView["status"] {
  return isSubagentStatus(entry.status) ? entry.status : "unknown"
}

function transcriptKindOf(entry: SessionSubagent): SubagentView["transcriptKind"] {
  const kind = entry.transcript?.kind
  return isSubagentTranscriptKind(kind) ? kind : "unknown"
}

function resolutionOf(entry: SessionSubagent, kind: SubagentView["transcriptKind"]): SubagentView["resolution"] {
  if (kind === "none") return "unavailable"
  if (entry.childSessionId) return "ready"
  return kind === "live" || kind === "file" || kind === "messages" ? "not-yet-bound" : "unavailable"
}

type ViewContext = {
  readonly parentSessionId: string
  readonly labels: SubagentLabels
  readonly toolCallId?: string
  readonly stops?: boolean
}

function stopCallOf(entry: SessionSubagent, stops: boolean | undefined): string | undefined {
  if (!stops || entry.mode !== "background" || (entry.status !== "running" && entry.status !== "pending")) return undefined
  return [...entry.toolCallEdges].find(([, role]) => role === "spawn")?.[0]
}

function subagentView(entry: SessionSubagent, context: ViewContext): SubagentView {
  const { parentSessionId, labels, toolCallId } = context
  const transcriptKind = transcriptKindOf(entry)
  const role = toolCallId ? entry.toolCallEdges.get(toolCallId) : undefined
  const stopCall = stopCallOf(entry, context.stops)
  return {
    parentSessionId,
    subagentKey: entry.subagentKey,
    ...(role ? { toolCallRole: role } : {}),
    ...(entry.mode ? { mode: entry.mode } : {}),
    status: subagentViewStatus(entry),
    label: entry.label || labels.subagent,
    agentLabel: entry.subagentType || entry.providerKind || labels.subagent,
    description: entry.description || labels.task,
    ...(entry.childSessionId ? { childSessionId: entry.childSessionId } : {}),
    transcriptKind,
    resolution: resolutionOf(entry, transcriptKind),
    ambient: entry.toolCallEdges.size === 0,
    ...(stopCall ? { stopCall } : {}),
  }
}

export function subagentViews(input: ViewContext & { readonly entries: readonly SessionSubagent[] }): SubagentView[] {
  return input.entries
    .filter((entry) => input.toolCallId === undefined || entry.toolCallEdges.has(input.toolCallId))
    .map((entry) => subagentView(entry, input))
}
