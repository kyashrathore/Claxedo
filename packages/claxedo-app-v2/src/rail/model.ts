import type { SessionRowView } from "@/session"

export type RailStatus = "pending" | "unknown" | "idle" | "working" | "waiting" | "retrying" | "recovering" | "failed"

export function railStatus(row: SessionRowView): RailStatus {
  if (row.pending) return "pending"
  if (row.waitingOnUser) return "waiting"
  return row.status.kind
}

export function matchesSearch(row: SessionRowView, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  return needle.length === 0 || row.title.toLocaleLowerCase().includes(needle)
}

export function searchRows(rows: readonly SessionRowView[], query: string): readonly SessionRowView[] {
  return rows.filter((row) => matchesSearch(row, query))
}
