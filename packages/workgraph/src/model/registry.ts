import { WorkGraph } from "./workgraph"
import type { WorkItem } from "./types"

let wg: WorkGraph | null = null
let file: string | undefined

/**
 * Initialize the singleton WorkGraph instance.
 * Call once at app startup.
 */
export function initWorkGraph(dbPath?: string): WorkGraph {
  const next = dbPath || undefined
  if (wg && file === next) return wg
  if (wg) {
    try { wg.close() } catch {}
  }
  wg = new WorkGraph(next)
  file = next
  return wg
}

/**
 * Get the singleton WorkGraph instance.
 * Lazily initializes with in-memory DB if not yet created.
 */
export function getWorkGraph(): WorkGraph {
  if (!wg) {
    wg = new WorkGraph()
    file = undefined
  }
  return wg
}

/**
 * Reset the singleton — used in tests.
 */
export function resetWorkGraph(): void {
  if (wg) {
    try { wg.close() } catch { /* already closed */ }
  }
  wg = null
  file = undefined
}

/**
 * Work items that are unblocked (no incomplete blockers, parent-aware).
 */
export function getReadyWork(): WorkItem[] {
  return getWorkGraph().getUnblocked()
}
