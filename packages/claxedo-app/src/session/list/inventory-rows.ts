import { matchesSessionActivity, sessionAttention, type SessionActivityFilter, type SessionId, type SessionLocation } from "@/server"
import type { InventoryWindow } from "./inventory-model"
import { compareOrder, orderKey, type ListEntry } from "./model"

export function inventoryRows(entries: ReadonlyMap<SessionId, ListEntry>, window: InventoryWindow, activity: SessionActivityFilter = "all"): readonly SessionLocation[] {
  return window.refs.flatMap((ref) => {
    const entry = entries.get(ref.sessionId)
    if (!entry || entry.kind === "tombstone" || entry.row.archivedAt !== undefined || entry.row.parentSessionId !== undefined) return []
    if (entry.row.attention && sessionAttention(entry.row.attention, entry.row.reader).settled) return []
    if (!matchesSessionActivity(entry.row.attention, activity)) return []
    return [entry]
  }).sort((left, right) => compareOrder(orderKey(left.row), orderKey(right.row))).map((entry) => entry.row.ref)
}
