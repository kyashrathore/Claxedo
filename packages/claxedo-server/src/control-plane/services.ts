import type { SyncDB } from "../sync-db"
import { createDurableSessionLog, type DurableSessionLog } from "./durable-session-log"
import { createProjectionStore, type ProjectionStore } from "./projection-store"

export type ControlPlaneServices = {
  projectionStore: ProjectionStore
  durableSessionLog: DurableSessionLog
}

export function createControlPlaneServices(input: { sync: SyncDB }): ControlPlaneServices {
  return {
    projectionStore: createProjectionStore(input.sync),
    durableSessionLog: createDurableSessionLog(input.sync),
  }
}
