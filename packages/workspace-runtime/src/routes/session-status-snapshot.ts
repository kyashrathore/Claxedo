import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { ACP_RECOVER } from "../adapters/acp-recovery"

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
    const type = typeof row.status === "string" ? row.status : undefined
    if (!id || !type || type === "idle") continue
    if (type === "busy") {
      out[id] = { type: "busy" }
      continue
    }
    if (type === "retry") {
      out[id] = {
        type: "retry",
        attempt: typeof row.attempt === "number" ? row.attempt : 1,
        message: typeof row.message === "string" ? row.message : ACP_RECOVER,
        next: typeof row.next === "number" ? row.next : Date.now(),
      }
    }
  }
  return out
}
