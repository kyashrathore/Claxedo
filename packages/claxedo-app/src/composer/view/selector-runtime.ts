import type { Accessor } from "solid-js"
import { useServer, type PlacementId } from "@/server"

export function createSelectorRuntime(placementId: Accessor<PlacementId | undefined>) {
  const server = useServer()
  const runtime = () => {
    const id = placementId()
    return id === undefined ? "live" : server.cloud.runtime(id).kind
  }
  return {
    asleep: () => runtime() === "asleep" || runtime() === "waking" || runtime() === "wakeFailed",
    waking: () => runtime() === "waking",
  }
}
