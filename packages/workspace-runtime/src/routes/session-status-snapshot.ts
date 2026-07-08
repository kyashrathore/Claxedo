import type { StatusCompat } from "@claxedo/agent-sdk-runtime/status"
import { ACP_RECOVER } from "@claxedo/agent-sdk-runtime/adapters"
import { live } from "../types/status"

function rec(input: unknown) {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null
}

export function sessionStatusSnapshot(input: unknown[]) {
  const out: Record<string, StatusCompat> = {}
  for (const item of input) {
    const row = rec(item)
    if (!row) continue
    const id = typeof row.id === "string" ? row.id : undefined
    if (!id) continue
    const status = live(row, ACP_RECOVER)
    if (!status) continue
    out[id] = status
  }
  return out
}
