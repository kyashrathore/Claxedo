import type { SubagentMode, SubagentStatus, SubagentToolCallRole, SubagentTranscript, SubagentWake } from "@claxedo/agent-runtime-contract"
import { isRecord } from "@claxedo/helpers/guards"
import type { Subagent } from "../types"

const TOOL_CALL_ROLES: ReadonlySet<string> = new Set<SubagentToolCallRole>(["spawn", "interaction"])
const MODES: ReadonlySet<string> = new Set<SubagentMode>(["foreground", "background"])
const STATUSES: ReadonlySet<string> = new Set<SubagentStatus>(["pending", "running", "paused", "interrupted", "completed", "failed", "killed"])
const TRANSCRIPT_KINDS: ReadonlySet<string> = new Set<SubagentTranscript["kind"]>(["live", "file", "messages", "none"])
const WAKES: ReadonlySet<string> = new Set<SubagentWake>(["pending", "delivered"])

type WireEdge = { readonly toolCallId?: unknown; readonly role?: unknown; readonly revision?: unknown }

function isToolCallRole(value: unknown): value is SubagentToolCallRole {
  return typeof value === "string" && TOOL_CALL_ROLES.has(value)
}

function isMode(value: unknown): value is SubagentMode {
  return typeof value === "string" && MODES.has(value)
}

function isStatus(value: unknown): value is SubagentStatus {
  return typeof value === "string" && STATUSES.has(value)
}

function isWake(value: unknown): value is SubagentWake {
  return typeof value === "string" && WAKES.has(value)
}

function isTranscriptKind(value: unknown): value is SubagentTranscript["kind"] {
  return typeof value === "string" && TRANSCRIPT_KINDS.has(value)
}

function transcriptFromWire(value: unknown): SubagentTranscript | undefined {
  if (!isRecord(value) || !isTranscriptKind(value.kind)) return undefined
  return { kind: value.kind, ...(typeof value.ref === "string" ? { ref: value.ref } : {}) }
}

export function subagentFromWire(value: unknown): Subagent | undefined {
  if (!isRecord(value) || typeof value.subagentKey !== "string" || typeof value.revision !== "number") return undefined
  const transcript = transcriptFromWire(value.transcript)
  return {
    subagentKey: value.subagentKey,
    revision: value.revision,
    ...(typeof value.toolCallId === "string" ? { toolCallId: value.toolCallId } : {}),
    ...(isToolCallRole(value.toolCallRole) ? { toolCallRole: value.toolCallRole } : {}),
    ...(isMode(value.mode) ? { mode: value.mode } : {}),
    ...(isStatus(value.status) ? { status: value.status } : {}),
    ...(typeof value.label === "string" ? { label: value.label } : {}),
    ...(typeof value.subagentType === "string" ? { subagentType: value.subagentType } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.providerId === "string" ? { providerId: value.providerId } : {}),
    ...(typeof value.providerKind === "string" ? { providerKind: value.providerKind } : {}),
    ...(typeof value.childSessionId === "string" ? { childSessionId: value.childSessionId } : {}),
    ...(transcript ? { transcript } : {}),
    ...(typeof value.attention === "number" ? { attention: value.attention } : {}),
    ...(isWake(value.wake) ? { wake: value.wake } : {}),
  }
}

function edgeUpdates(subagent: Subagent, edges: unknown): Subagent[] {
  if (!Array.isArray(edges)) return []
  return edges.flatMap((edge: WireEdge) =>
    typeof edge?.toolCallId === "string" && isToolCallRole(edge.role) && typeof edge.revision === "number"
      ? [{ subagentKey: subagent.subagentKey, revision: edge.revision, toolCallId: edge.toolCallId, toolCallRole: edge.role }]
      : [],
  )
}

function toolCallEdges(row: unknown): unknown {
  return row && typeof row === "object" && "toolCallEdges" in row ? row.toolCallEdges : undefined
}

export function subagentsFromWire(body: unknown): readonly Subagent[] {
  const rows: readonly unknown[] = Array.isArray(body) ? body : []
  return rows.flatMap((row) => {
    const subagent = subagentFromWire(row)
    return subagent ? [subagent, ...edgeUpdates(subagent, toolCallEdges(row))] : []
  })
}
