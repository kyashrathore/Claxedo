import { useServer, type DiffScope, type GitCommitInput, type GitPushInput, type PlacementId } from "@/server"

export function useReviewApi() {
  const server = useServer()
  return {
    status: (placementId: PlacementId) => server.queries.git.status(placementId),
    log: (placementId: PlacementId, limit: number) => server.queries.git.log(placementId, limit),
    diff: (placementId: PlacementId, scope: DiffScope) => server.queries.git.diff(placementId, scope),
    diffFile: (placementId: PlacementId, scope: DiffScope, file: string) =>
      server.queries.git.diffFile(placementId, scope, file),
    refs: (placementId: PlacementId) => server.queries.git.refs(placementId),
    bases: (placementId: PlacementId) => server.queries.git.bases(placementId),
    stage: (placementId: PlacementId, paths: readonly string[]) => server.git.stage(placementId, paths),
    unstage: (placementId: PlacementId, paths: readonly string[]) => server.git.unstage(placementId, paths),
    commit: (placementId: PlacementId, input: GitCommitInput) => server.git.commit(placementId, input),
    push: (placementId: PlacementId, input: GitPushInput) => server.git.push(placementId, input),
  }
}
