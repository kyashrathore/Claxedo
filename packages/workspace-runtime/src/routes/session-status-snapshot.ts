import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { ACP_RECOVER } from "../adapters/acp-recovery"
import { live } from "../types/status"

function rec(input: unknown) {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null
}

export function sessionStatusSnapshot(input: unknown[]) {
  const out: Record<string, SessionStatus> = {}
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
