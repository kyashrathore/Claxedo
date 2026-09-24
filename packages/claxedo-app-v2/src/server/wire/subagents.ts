import type { Subagent } from "../types"

export function subagentFromWire(value: unknown): Subagent | undefined {
  if (!value || typeof value !== "object") return undefined
  const row = value as { subagentKey?: unknown; revision?: unknown }
  return typeof row.subagentKey === "string" && typeof row.revision === "number" ? (value as Subagent) : undefined
}

export function subagentsFromWire(body: unknown): readonly Subagent[] {
  return (Array.isArray(body) ? body : []).flatMap((row) => subagentFromWire(row) ?? [])
}
