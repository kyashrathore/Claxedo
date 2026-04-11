import type { AgentAdapter } from "../../../workspace-runtime/src/adapters/index"
import type { SyncDB } from "../sync-db"
import type { Workspace } from "../workspace-store"
import type { HarnessHost } from "./host"
import { PiAdapter } from "./pi-adapter"

export function createPiHost(sync: SyncDB): HarnessHost {
  const adapters = new Map<string, AgentAdapter>()
  return {
    id: "pi",
    async createAdapter(ws: Workspace) {
      const hit = adapters.get(ws.id)
      if (hit) return hit
      const next = new PiAdapter(ws, sync)
      adapters.set(ws.id, next)
      return next
    },
  }
}
