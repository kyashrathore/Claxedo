import type { ChangeCursor } from "@claxedo/workgraph/contracts"
import { WorkGraphApiError, type WorkGraphClient } from "./api"

export async function syncWorkGraphChanges(
  client: Pick<WorkGraphClient, "changes">,
  cursor: ChangeCursor,
  reload: () => unknown | Promise<unknown>,
) {
  try {
    const result = await client.changes(cursor)
    if (result.changes.length === 0) return "current" as const
    await reload()
    return "reloaded" as const
  } catch (error) {
    if (!(error instanceof WorkGraphApiError) || error.kind !== "cursor_invalid") throw error
    await reload()
    return "reset" as const
  }
}
