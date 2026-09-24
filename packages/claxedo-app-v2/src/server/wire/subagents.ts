import type { Subagent } from "../types"

const HOST_ROW_ONLY = ["toolCallEdges", "parentSessionId"] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function subagentFromWire(value: unknown): Subagent | undefined {
  if (!isRecord(value)) return undefined
  return typeof value.subagentKey === "string" && typeof value.revision === "number" ? (value as Subagent) : undefined
}

function edgeUpdates(subagentKey: string, edges: unknown): Subagent[] {
  return (Array.isArray(edges) ? edges : []).flatMap((edge) => {
    if (!isRecord(edge) || typeof edge.toolCallId !== "string" || typeof edge.revision !== "number") return []
    if (edge.role !== "spawn" && edge.role !== "interaction") return []
    return [{ subagentKey, revision: edge.revision, toolCallId: edge.toolCallId, toolCallRole: edge.role }]
  })
}

function hostRowUpdates(row: Record<string, unknown>, subagent: Subagent): Subagent[] {
  const update: Record<string, unknown> = { ...row }
  for (const key of HOST_ROW_ONLY) delete update[key]
  return [update as Subagent, ...edgeUpdates(subagent.subagentKey, row.toolCallEdges)]
}

export function subagentsFromWire(body: unknown): readonly Subagent[] {
  return (Array.isArray(body) ? body : []).flatMap((row) => {
    const subagent = subagentFromWire(row)
    return subagent && isRecord(row) ? hostRowUpdates(row, subagent) : []
  })
}
