import { live, type StatusCompat } from "@claxedo/agent-sdk-runtime/status"
import { ACP_RECOVER } from "@claxedo/agent-sdk-runtime/adapters"
import { str } from "../json-value"
import { asRecord } from "@claxedo/helpers/guards"

export type SessionStatusSnapshot = Record<string, StatusCompat>

export function sessionStatusSnapshot(input: unknown[]): SessionStatusSnapshot {
  const out: SessionStatusSnapshot = {}
  for (const item of input) {
    const row = asRecord(item)
    if (!row) continue
    const id = str(row.id)
    if (!id) continue
    const status = live(row, ACP_RECOVER)
    if (!status) continue
    out[id] = status
  }
  return out
}
