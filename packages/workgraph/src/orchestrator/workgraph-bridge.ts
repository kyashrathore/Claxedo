import { WorkGraph } from "../model/workgraph"
import type { WorkItem } from "../model/types"

let wg: WorkGraph | null = null
let file: string | undefined
const runToItem = new Map<string, string>()
const itemToRun = new Map<string, string>()

/**
 * Initialize the singleton WorkGraph instance.
 * Call once at app startup.
 */
export function initWorkGraph(dbPath?: string): WorkGraph {
  const next = dbPath || undefined
  if (wg && file === next) return wg
  if (wg) {
    try { wg.close() } catch {}
    runToItem.clear()
    itemToRun.clear()
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
  runToItem.clear()
  itemToRun.clear()
}

/**
 * Link an orchestration run to a WorkItem.
 */
export function linkRun(runId: string, itemId: string): void {
  const g = getWorkGraph()
  const item = g.get(itemId)
  if (!item) {
    console.warn(`[workgraph-bridge] linkRun: item ${itemId} not found, skipping`)
    return
  }
  runToItem.set(runId, itemId)
  itemToRun.set(itemId, runId)
}

/**
 * Unlink an orchestration run from its WorkItem.
 */
export function unlinkRun(runId: string): void {
  const itemId = runToItem.get(runId)
  if (itemId) {
    itemToRun.delete(itemId)
  }
  runToItem.delete(runId)
}

/**
 * Get the WorkItem linked to a run, if any.
 */
export function getItemForRun(runId: string): WorkItem | undefined {
  const itemId = runToItem.get(runId)
  if (!itemId) return undefined
  return getWorkGraph().get(itemId)
}

/**
 * Called when any node in a run completes.
 * Transitions the linked item from open → in_progress.
 */
export function onNodeCompleted(runId: string): void {
  const itemId = runToItem.get(runId)
  if (!itemId) return

  const g = getWorkGraph()
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
  const itemId = runToItem.get(runId)
  if (!itemId) return

  const g = getWorkGraph()
  const item = g.get(itemId)
  if (!item) return

  // complete() sets status to "done" and handles downstream notifications
  await g.complete(itemId)
  // Clean up the link
  unlinkRun(runId)
}

/**
 * Called when a run fails. No-op: the item stays in its current status
 * so it can be retried.
 */
export function onRunFailed(_runId: string): void {
  // intentional no-op — item stays open/in_progress for retry
}

export function syncSourcePlan(db: any, runId: string, sourceId: string): Map<string, string> {
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
  for (const id of missions) {
    g.ensureSynthesis(id)
  }

  return map
}

export function markNodeActive(map: Map<string, string>, nodeId: string): void {
  const itemId = map.get(nodeId)
  if (!itemId) return
  const g = getWorkGraph()
  const item = g.get(itemId)
  if (!item) return
  if (item.status === "done") return
  g.update(itemId, { status: "in_progress" })
}

export async function markNodeDone(map: Map<string, string>, nodeId: string): Promise<void> {
  const itemId = map.get(nodeId)
  if (!itemId) return
  const g = getWorkGraph()
  const item = g.get(itemId)
  if (!item) return
  await g.complete(itemId)
}

export function markNodeOpen(map: Map<string, string>, nodeId: string): void {
  const itemId = map.get(nodeId)
  if (!itemId) return
  const g = getWorkGraph()
  const item = g.get(itemId)
  if (!item) return
  if (item.status === "done") return
  g.update(itemId, { status: "open" })
}

/**
 * Create WorkGraph items from a decomposition plan and wire up dependencies.
 * Returns a Map of node_id → WorkGraph item ID.
 *
 * @param plan - The decomposed plan with tasks and dependencies
 * @param taskNodeMap - Maps planner task id → DB node_id
 * @param runId - The orchestration run ID (stored in item context)
 */
export function createItemsFromPlan(
  plan: { tasks: Array<{ id: string; title: string; prompt: string; kind: string; depends_on: string[] }> },
  taskNodeMap: Map<string, string>,
  runId: string,
): Map<string, string> {
  const g = getWorkGraph()
  const nodeToWorkItem = new Map<string, string>()

  // Create WorkGraph items for each task
  for (const task of plan.tasks) {
    const nodeId = taskNodeMap.get(task.id)
    if (!nodeId) continue

    const item = g.create({
      title: task.title,
      description: task.prompt,
      nodeType: "task",
      labels: [task.kind],
      context: `run:${runId} node:${nodeId}`,
    })

    nodeToWorkItem.set(nodeId, item.id)
  }

  // Add WorkGraph dependencies between items
  for (const task of plan.tasks) {
    const targetNodeId = taskNodeMap.get(task.id)
    if (!targetNodeId) continue
    const blockedItemId = nodeToWorkItem.get(targetNodeId)
    if (!blockedItemId) continue

    for (const depTaskId of task.depends_on) {
      const sourceNodeId = taskNodeMap.get(depTaskId)
      if (!sourceNodeId) continue
      const blockingItemId = nodeToWorkItem.get(sourceNodeId)
      if (!blockingItemId) continue

      try {
        g.addDep(blockingItemId, blockedItemId)
      } catch {
        // skip if cycle or items don't exist
      }
    }
  }

  return nodeToWorkItem
}

/**
 * Get work items that are unblocked and have no active run linked.
 */
export function getReadyWork(): WorkItem[] {
  const g = getWorkGraph()
  const unblocked = g.getUnblocked()
  return unblocked.filter((item) => !itemToRun.has(item.id))
}
