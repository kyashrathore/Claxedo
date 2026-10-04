import { useServer, type PlacementId } from "@/server"

export function useFilesApi() {
  const server = useServer()
  return {
    tree: (placementId: PlacementId, path: string) => server.queries.files.tree(placementId, path),
    content: (placementId: PlacementId, path: string) => server.queries.files.content(placementId, path),
    search: (placementId: PlacementId, query: string) => server.queries.files.search(placementId, query, "files"),
    changes: (placementId: PlacementId) => server.queries.git.status(placementId),
  }
}
