import type { Accessor } from "solid-js"
import { runsInSessionHost } from "@/lib/harness-selection"
import { useServer, type PlacementId, type WorkspaceRuntime } from "@/server"
import type { HarnessType } from "../harness/profile"

const LIVE: WorkspaceRuntime = { kind: "live" }

export function harnessMachineRuntime(machine: Accessor<WorkspaceRuntime>, harness: Accessor<HarnessType | undefined>) {
  const runtime = (): WorkspaceRuntime => (runsInSessionHost(harness()) ? LIVE : machine())
  return {
    runtime,
    asleep: () => runtime().kind === "asleep" || runtime().kind === "waking" || runtime().kind === "wakeFailed",
  }
}

export function createSelectorRuntime(placementId: Accessor<PlacementId | undefined>, harness: Accessor<HarnessType | undefined>) {
  const server = useServer()
  return harnessMachineRuntime(() => {
    const id = placementId()
    return id === undefined ? LIVE : server.cloud.runtime(id)
  }, harness)
}
