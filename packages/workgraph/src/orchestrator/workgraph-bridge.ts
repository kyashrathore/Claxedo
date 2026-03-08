import { WorkGraph, type WorkItem } from "@opencode-ai/workgraph"

let wg: WorkGraph | null = null
const runToItem = new Map<string, string>()
const itemToRun = new Map<string, string>()

/**
 * Initialize the singleton WorkGraph instance.
 * Call once at app startup.
 */
export function initWorkGraph(dbPath?: string): WorkGraph {
  if (wg) return wg
  wg = new WorkGraph(dbPath)
  return wg
}

/**
 * Get the singleton WorkGraph instance.
 * Lazily initializes with in-memory DB if not yet created.
 */
export function getWorkGraph(): WorkGraph {
  if (!wg) wg = new WorkGraph()
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
