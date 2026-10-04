import { isSubagentMode, isSubagentStatus, isSubagentToolCallRole, isSubagentTranscriptKind, isSubagentWake, type SubagentTranscript } from "@claxedo/agent-runtime-contract"
import { isRecord } from "@claxedo/helpers/guards"
import type { Subagent } from "../types"

type WireEdge = { readonly toolCallId?: unknown; readonly role?: unknown; readonly revision?: unknown }

function transcriptFromWire(value: unknown): SubagentTranscript | undefined {
  if (!isRecord(value) || !isSubagentTranscriptKind(value.kind)) return undefined
  return { kind: value.kind, ...(typeof value.ref === "string" ? { ref: value.ref } : {}) }
}

export function subagentFromWire(value: unknown): Subagent | undefined {
  if (!isRecord(value) || typeof value.subagentKey !== "string" || typeof value.revision !== "number") return undefined
  const transcript = transcriptFromWire(value.transcript)
  return {
    subagentKey: value.subagentKey,
    revision: value.revision,
    ...(typeof value.toolCallId === "string" ? { toolCallId: value.toolCallId } : {}),
    ...(isSubagentToolCallRole(value.toolCallRole) ? { toolCallRole: value.toolCallRole } : {}),
    ...(isSubagentMode(value.mode) ? { mode: value.mode } : {}),
    ...(isSubagentStatus(value.status) ? { status: value.status } : {}),
    ...(typeof value.label === "string" ? { label: value.label } : {}),
    ...(typeof value.subagentType === "string" ? { subagentType: value.subagentType } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.providerId === "string" ? { providerId: value.providerId } : {}),
    ...(typeof value.providerKind === "string" ? { providerKind: value.providerKind } : {}),
    ...(typeof value.childSessionId === "string" ? { childSessionId: value.childSessionId } : {}),
    ...(transcript ? { transcript } : {}),
    ...(typeof value.attention === "number" ? { attention: value.attention } : {}),
    ...(isSubagentWake(value.wake) ? { wake: value.wake } : {}),
  }
}

function edgeUpdates(subagent: Subagent, edges: unknown): Subagent[] {
  if (!Array.isArray(edges)) return []
  return edges.flatMap((edge: WireEdge) =>
    typeof edge?.toolCallId === "string" && isSubagentToolCallRole(edge.role) && typeof edge.revision === "number"
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
