import type {
  SubagentMode,
  SubagentStatus,
  SubagentToolCallRole,
  SubagentTranscript,
  SubagentUpdatedEvent,
} from "@claxedo/agent-event-runtime"
import type { SubagentRegistry, SubagentRegistryEntry } from "./subagent-registry"

export type HostSubagentRow = {
  subagentKey: string
  revision: number
  mode?: SubagentMode
  status?: SubagentStatus
  label?: string
  subagentType?: string
  description?: string
  providerId?: string
  providerKind?: string
  childSessionId?: string
  transcript?: SubagentTranscript
  toolCallEdges?: Array<{
    toolCallId: string
    role: SubagentToolCallRole
    revision: number
  }>
}

export type SubagentPresentation = {
  parentSessionId: string
  subagentKey: string
  toolCallRole?: SubagentToolCallRole
  mode?: SubagentMode
  status: SubagentStatus | "unknown"
  label: string
  agentLabel: string
  description: string
  childSessionId?: string
  transcriptKind: SubagentTranscript["kind"] | "unknown"
  resolution: "not-yet-bound" | "loading" | "ready" | "empty" | "unavailable"
  ambient: boolean
}

// `active` is the abort gate: hydration walks a whole page of host rows into
// the registry, and a session the user has already switched away from must stop
// applying events instead of finishing the walk against a dead panel.
export function hydrateSubagentRows(
  registry: SubagentRegistry,
  parentSessionId: string,
  rows: HostSubagentRow[],
  active: () => boolean = () => true,
) {
  for (const row of rows) {
    if (!active()) return
    registry.apply(parentSessionId, eventFromRow(row))
    for (const edge of row.toolCallEdges ?? []) {
      if (!active()) return
      registry.apply(parentSessionId, {
        type: "subagent-updated",
        subagentKey: row.subagentKey,
        revision: edge.revision,
        toolCallId: edge.toolCallId,
        toolCallRole: edge.role,
      })
    }
  }
}

export function presentSubagents(registry: SubagentRegistry, parentSessionId: string, toolCallId?: string) {
  return registry
    .list(parentSessionId)
    .filter((entry) => toolCallId === undefined || entry.toolCallEdges.has(toolCallId))
    .map((entry) => presentSubagent(entry, toolCallId))
    .sort((a, b) => a.subagentKey.localeCompare(b.subagentKey))
}

export function subagentStatusLabel(status: SubagentPresentation["status"]) {
  switch (status) {
    case "pending":
      return "Pending"
    case "running":
      return "Working"
    case "paused":
      return "Paused"
    case "interrupted":
      return "Interrupted"
    case "completed":
      return "Completed"
    case "failed":
      return "Failed"
    case "killed":
      return "Killed"
    default:
      return "Status unavailable"
  }
}

function eventFromRow(row: HostSubagentRow): SubagentUpdatedEvent {
  return {
    type: "subagent-updated",
    subagentKey: row.subagentKey,
    revision: row.revision,
    ...(row.mode ? { mode: row.mode } : {}),
    ...(row.status ? { status: row.status } : {}),
    ...(row.label ? { label: row.label } : {}),
    ...(row.subagentType ? { subagentType: row.subagentType } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(row.providerId ? { providerId: row.providerId } : {}),
    ...(row.providerKind ? { providerKind: row.providerKind } : {}),
    ...(row.childSessionId ? { childSessionId: row.childSessionId } : {}),
    ...(row.transcript ? { transcript: row.transcript } : {}),
  }
}

function presentSubagent(entry: SubagentRegistryEntry, toolCallId?: string): SubagentPresentation {
  const transcriptKind = transcript(entry.transcript?.kind)
  return {
    parentSessionId: entry.parentSessionId,
    subagentKey: entry.subagentKey,
    ...(toolCallId ? { toolCallRole: entry.toolCallEdges.get(toolCallId) } : {}),
    ...(entry.mode ? { mode: entry.mode } : {}),
    status: status(entry.status),
    label: entry.label || "Subagent",
    agentLabel: entry.subagentType || entry.providerKind || "Subagent",
    description: entry.description || "Delegated task",
    ...(entry.childSessionId ? { childSessionId: entry.childSessionId } : {}),
    transcriptKind,
    resolution:
      transcriptKind === "none"
        ? "unavailable"
        : entry.childSessionId
          ? "ready"
          : transcriptKind === "live" || transcriptKind === "file" || transcriptKind === "messages"
            ? "not-yet-bound"
            : "unavailable",
    ambient: entry.toolCallEdges.size === 0,
  }
}

function status(value: unknown): SubagentPresentation["status"] {
  if (
    value === "pending" ||
    value === "running" ||
    value === "paused" ||
    value === "interrupted" ||
    value === "completed" ||
    value === "failed" ||
    value === "killed"
  )
    return value
  return "unknown"
}

function transcript(value: unknown): SubagentPresentation["transcriptKind"] {
  if (value === "live" || value === "file" || value === "messages" || value === "none") return value
  return "unknown"
}
