import type { ConnectorInterface } from "../orchestrator/events/connector"
import type { WorkItem } from "./types"

export interface HookAction {
  itemId: string
  action: string
}

export async function onComplete(
  item: WorkItem,
  downstream: WorkItem[],
  getBlockedBy: (id: string) => WorkItem[],
  connector?: ConnectorInterface,
): Promise<HookAction[]> {
  const actions: HookAction[] = []

  if (!connector) return actions

  for (const target of downstream) {
    if (!target.providerMeta) continue

    try {
      await connector.addComment(
        target.providerMeta,
        `Blocking issue '${item.title}' completed.`,
      )
      actions.push({ itemId: target.id, action: "comment_added" })
    } catch (err) {
      console.warn(`[workgraph] Failed to push comment to ${target.id}:`, err)
    }

    const blockers = getBlockedBy(target.id)
    const allDone = blockers.every((b) => b.status === "done")
    if (allDone) {
      try {
        await connector.updateIssue(target.providerMeta, { status: "open" })
        actions.push({ itemId: target.id, action: "status_unblocked" })
      } catch (err) {
        console.warn(`[workgraph] Failed to update status for ${target.id}:`, err)
      }
    }
  }

  return actions
}
