import type { SubagentToolCallRole } from "@claxedo/agent-runtime-contract"
import type { Subagent } from "../types"

const TOOL_CALL_ROLES: ReadonlySet<string> = new Set<SubagentToolCallRole>(["spawn", "interaction"])

type WireEdge = { readonly toolCallId?: unknown; readonly role?: unknown; readonly revision?: unknown }

function isToolCallRole(value: unknown): value is SubagentToolCallRole {
  return typeof value === "string" && TOOL_CALL_ROLES.has(value)
}

export function subagentFromWire(value: unknown): Subagent | undefined {
  if (!value || typeof value !== "object") return undefined
  const row = value as { subagentKey?: unknown; revision?: unknown }
  return typeof row.subagentKey === "string" && typeof row.revision === "number" ? (value as Subagent) : undefined
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
