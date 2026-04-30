import type { AgentAdapter } from "../../../workspace-runtime/src/adapters/index"
import type { ProjectionStore } from "../control-plane/projection-store"
import type { Workspace } from "../workspace-store"
import type { HarnessHost } from "./host"
import { PiAdapter } from "./pi-adapter"

export function createPiHost(projectionStore: ProjectionStore): HarnessHost {
  const adapters = new Map<string, AgentAdapter>()
  return {
    id: "pi",
    async createAdapter(ws: Workspace) {
      const hit = adapters.get(ws.id)
      if (hit) return hit
      const next = new PiAdapter(ws, projectionStore)
      adapters.set(ws.id, next)
      return next
    },
  }
}
