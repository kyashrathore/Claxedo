import type { ControlPlaneEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import { parseSessionStateEvent } from "@claxedo/server-core/platform/runtime/lib/session-state-events"
import { storedSessionShareLevel } from "@claxedo/server-core/platform/auth/session-share-level"
import { asRecord } from "@claxedo/server-core/platform/json/index"

export function liveSyncEvent(input: unknown): ControlPlaneEvent | undefined {
  const state = parseSessionStateEvent(input)
  if (state?.ownerUserId) return state
  const row = asRecord(input)
  const ts = row?.ts
  if (!row || typeof ts !== "number" || !Number.isFinite(ts)) return undefined
  const { ownerUserId, sessionId, workspaceId, phase } = row
  if (
    row.type === "session.share.changed"
    && typeof ownerUserId === "string" && ownerUserId
    && typeof sessionId === "string"
    && typeof workspaceId === "string"
    && (phase === "granted" || phase === "revoked")
  ) {
    const base = { type: "session.share.changed", ts, ownerUserId, sessionId, workspaceId } as const
    return phase === "granted"
      ? { ...base, phase, level: storedSessionShareLevel(row.level) }
      : { ...base, phase }
  }
  return undefined
}
