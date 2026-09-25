import { createStore, produce } from "solid-js/store"
import type { WorkspaceStartProgress } from "./cloud-types"
import type { PlacementId } from "./ids"
import { isStoppedCloud } from "./placement-runtime"
import type { Transport } from "./transport"
import type { Workspaces } from "./workspaces"

export type WorkspaceWakes = {
  readonly waking: (id: PlacementId) => WorkspaceStartProgress | undefined
  readonly start: (id: PlacementId) => Promise<void>
  readonly wakeIfStopped: (id: PlacementId) => Promise<void>
}

export function createWorkspaceWakes(transport: Transport, workspaces: Workspaces): WorkspaceWakes {
  const [waking, setWaking] = createStore<Record<string, WorkspaceStartProgress | undefined>>({})
  const running = new Map<string, Promise<void>>()
  const run = async (id: PlacementId) => {
    setWaking(id, { kind: "provisioning" })
    try {
      const { workspaceId } = await workspaces.locate(id)
      await transport.startRuntime(workspaceId, { onProgress: (progress) => setWaking(id, progress) })
      await workspaces.refresh()
    } finally {
      setWaking(produce((all) => void delete all[id]))
      running.delete(id)
    }
  }
  const start = (id: PlacementId) => {
    const current = running.get(id)
    if (current) return current
    const next = run(id)
    running.set(id, next)
    return next
  }
  return {
    waking: (id) => waking[id],
    start,
    wakeIfStopped: async (id) => {
      await workspaces.load()
      if (isStoppedCloud(workspaces.byId(id))) await start(id)
    },
  }
}
