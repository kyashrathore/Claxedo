import { WorkGraph } from "./model/workgraph"
import type { WorkItem } from "./model/types"
import type { OrchestratorHooks } from "./orchestrator/types"

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
 * Link an orchestration run to a WorkItem (persisted in WorkGraph DB).
 */
export function linkRun(runId: string, itemId: string): void {
  const g = getWorkGraph()
  const item = g.get(itemId)
  if (!item) {
    console.warn(`[workgraph-bridge] linkRun: item ${itemId} not found, skipping`)
    return
  }
  g.linkRun(runId, itemId)
}

/**
 * Unlink an orchestration run from its WorkItem.
 */
export function unlinkRun(runId: string): void {
  getWorkGraph().unlinkRun(runId)
}

/**
 * Get the WorkItem linked to a run, if any.
 */
export function getItemForRun(runId: string): WorkItem | undefined {
  const itemId = getWorkGraph().getLinkedItemId(runId)
  if (!itemId) return undefined
  return getWorkGraph().get(itemId)
}

/**
 * Called when any node in a run completes.
 * Transitions the linked item from open → in_progress.
 */
export function onNodeCompleted(runId: string): void {
  const g = getWorkGraph()
  const itemId = g.getLinkedItemId(runId)
  if (!itemId) return
  const item = g.get(itemId)
  if (!item) return
  if (item.status === "open") {
    g.update(itemId, { status: "in_progress" })
  }
}

/**
 * Called when a run completes successfully.
 * Marks the linked item as done (which may unblock downstream items).
 */
export async function onRunCompleted(runId: string): Promise<void> {
  const g = getWorkGraph()
  const itemId = g.getLinkedItemId(runId)
  if (!itemId) return
  const item = g.get(itemId)
  if (!item) return
  await g.complete(itemId)
  g.unlinkRun(runId)
}

/**
 * Called when a run fails. No-op: the item stays in its current status
 * so it can be retried.
 */
export function onRunFailed(_runId: string): void {
  // intentional no-op — item stays open/in_progress for retry
}

/**
 * Sync WorkGraph items from a source plan.
 * Also writes the nodeId→itemId mapping into run_node_items_current
 * in the orchestrator DB so it survives process crashes.
 */
export function syncSourcePlan(db: any, runId: string, sourceId: string): void {
  const g = getWorkGraph()
  g.removeBySource(sourceId)
  const src = db
    .query("SELECT goal, title, content, kind, repo_ref, repo_label FROM sources_current WHERE source_id = ?")
    .get(sourceId) as { goal: string; title: string; content: string; kind: string; repo_ref: string | null; repo_label: string | null } | null
  const root = g.create({
    sourceId,
    repoRef: src?.repo_ref ?? null,
    repoLabel: src?.repo_label ?? null,
    title: src?.goal || src?.title || "Mission",
    description: src?.content ?? "",
    nodeType: "mission",
    labels: ["mission", src?.kind ?? "spec"],
    context: `source:${sourceId} mission:root`,
  })

  const nodes = db
    .query("SELECT node_id, kind, title, node_type, parent_node_id FROM nodes_current WHERE run_id = ? ORDER BY rowid ASC")
    .all(runId) as Array<{ node_id: string; kind: string; title: string; node_type: string | null; parent_node_id: string | null }>

  const prompts = new Map(
    (
      db
        .query(
          "SELECT node_id, content FROM scratchpad_entries WHERE run_id = ? ORDER BY created_at ASC",
        )
        .all(runId) as Array<{ node_id: string; content: string }>
    ).map((row) => [row.node_id, row.content]),
  )

  const map = new Map<string, string>()
  for (const node of nodes) {
    const nodeType = node.node_type === "mission" || node.node_type === "synthesis" ? node.node_type : "task"
    const parentId = node.parent_node_id ? map.get(node.parent_node_id) ?? root.id : root.id
    const item = g.create({
      sourceId,
      parentId,
      repoRef: src?.repo_ref ?? null,
      repoLabel: src?.repo_label ?? null,
      title: node.title,
      description: prompts.get(node.node_id) ?? "",
      nodeType,
      labels: Array.from(new Set([node.kind, nodeType])),
      context: `source:${sourceId} node:${node.node_id}`,
    })
    map.set(node.node_id, item.id)
    // Persist the nodeId→itemId mapping in the orchestrator DB
    db.run(
      "INSERT OR IGNORE INTO run_node_items_current (run_id, node_id, work_item_id) VALUES (?, ?, ?)",
      [runId, node.node_id, item.id],
    )
  }

  const edges = db
    .query("SELECT source_id, target_id FROM dependency_edges_current WHERE run_id = ?")
    .all(runId) as Array<{ source_id: string; target_id: string }>

  for (const edge of edges) {
    const source = map.get(edge.source_id)
    const target = map.get(edge.target_id)
    if (!source || !target) continue
    try {
      g.addDep(source, target)
    } catch {
      // keep best-effort sync for now
    }
  }

  const missions = [root.id, ...nodes
    .filter((node) => node.node_type === "mission")
    .map((node) => map.get(node.node_id))
    .filter((id): id is string => !!id)]
  for (const id of missions) {
    g.ensureSynthesis(id)
  }
}

/**
 * Get work items that are unblocked and have no active run linked.
 */
export function getReadyWork(): WorkItem[] {
  const g = getWorkGraph()
  const unblocked = g.getUnblocked()
  return unblocked.filter((item) => !g.getLinkedRunId(item.id))
}

/**
 * Resolve the WorkGraph item ID for a given orchestrator nodeId.
 * Queries run_node_items_current in the orchestrator DB.
 */
function resolveNodeItemId(orchDb: any, runId: string, nodeId: string): string | undefined {
  const row = orchDb
    .query("SELECT work_item_id FROM run_node_items_current WHERE run_id = ? AND node_id = ?")
    .get(runId, nodeId) as { work_item_id: string } | undefined
  return row?.work_item_id
}

/**
 * Create an OrchestratorHooks implementation that keeps WorkGraph in sync
 * with orchestration lifecycle events. Stateless: all lookups go to the DB.
 *
 * @param orchDb - The orchestrator SQLite database instance.
 */
export function createWorkGraphHooks(orchDb: any): OrchestratorHooks {
  return {
    onPlanSynced(db, runId, sourceId) {
      syncSourcePlan(db, runId, sourceId)
    },

    onNodeActive(runId, nodeId) {
      const itemId = resolveNodeItemId(orchDb, runId, nodeId)
      if (!itemId) return
      const g = getWorkGraph()
      const item = g.get(itemId)
      if (!item || item.status === "done") return
      g.update(itemId, { status: "in_progress" })
    },

    async onNodeCompleted(runId, nodeId) {
      onNodeCompleted(runId)
      const itemId = resolveNodeItemId(orchDb, runId, nodeId)
      if (!itemId) return
      const g = getWorkGraph()
      const item = g.get(itemId)
      if (item) await g.complete(itemId)
    },

    onNodeFailed(runId, nodeId) {
      const itemId = resolveNodeItemId(orchDb, runId, nodeId)
      if (!itemId) return
      const g = getWorkGraph()
      const item = g.get(itemId)
      if (!item || item.status === "done") return
      g.update(itemId, { status: "open" })
    },

    async onRunCompleted(runId) {
      await onRunCompleted(runId)
    },

    onRunCancelled(runId) {
      unlinkRun(runId)
    },

    sourceHasWork(sourceId) {
      return getWorkGraph().getBySource(sourceId).some((item) => item.status !== "done")
    },
  }
}

/**
 * After a crash, reconcile WorkGraph item statuses against the orchestrator DB.
 * Call once at startup before serving any requests.
 *
 * - Completed/failed/cancelled runs → mark linked WorkGraph items done or reset to open
 * - Items stuck in_progress with no active run link → reset to open
 */
export async function reconcileOnStartup(orchDb: any): Promise<void> {
  const g = getWorkGraph()
  const links = g.getAllRunLinks()

  for (const { runId, itemId } of links) {
    const run = orchDb
      .query("SELECT status FROM runs_current WHERE run_id = ?")
      .get(runId) as { status: string } | undefined

    if (!run) {
      g.unlinkRun(runId)
      continue
    }

    if (run.status === "completed") {
      const item = g.get(itemId)
      if (item && item.status !== "done") await g.complete(itemId)
      g.unlinkRun(runId)
    } else if (run.status === "failed" || run.status === "cancelled") {
      const item = g.get(itemId)
      if (item && item.status === "in_progress") g.update(itemId, { status: "open" })
      g.unlinkRun(runId)
    }
    // Non-terminal runs (planning/executing/planned/blocked): leave the link in place
  }

  // Reset any item stuck in_progress with no active run link
  for (const item of g.getAll()) {
    if (item.status !== "in_progress") continue
    if (!g.getLinkedRunId(item.id)) {
      g.update(item.id, { status: "open" })
    }
  }
}
