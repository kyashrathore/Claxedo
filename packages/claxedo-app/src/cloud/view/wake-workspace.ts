import { useServer, type PlacementId } from "@/server"

export function useWakeWorkspace(): (id: PlacementId) => void {
  const server = useServer()
  return (id) => void server.cloud.start(id).catch((error: unknown) => console.warn("The workspace could not be woken", { placementId: id, error }))
}
