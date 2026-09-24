import {
  useServer,
  type DiffScope,
  type GitCommitInput,
  type GitPushInput,
  type PlacementId,
  type ProjectId,
  type WorktreeCreateInput,
} from "@/server"

export function useReviewApi() {
  const server = useServer()
  return {
    status: (placementId: PlacementId) => server.queries.git.status(placementId),
    diff: (placementId: PlacementId, scope: DiffScope) => server.queries.git.diff(placementId, scope),
    diffFile: (placementId: PlacementId, scope: DiffScope, file: string) =>
      server.queries.git.diffFile(placementId, scope, file),
    refs: (placementId: PlacementId) => server.queries.git.refs(placementId),
    bases: (placementId: PlacementId) => server.queries.git.bases(placementId),
    placementsOf: (projectId: ProjectId) => server.queries.placements.byProject(projectId),
    placement: (placementId: PlacementId) => server.placements.byId(placementId),
    stage: (placementId: PlacementId, paths: readonly string[]) => server.git.stage(placementId, paths),
    unstage: (placementId: PlacementId, paths: readonly string[]) => server.git.unstage(placementId, paths),
    commit: (placementId: PlacementId, input: GitCommitInput) => server.git.commit(placementId, input),
    push: (placementId: PlacementId, input: GitPushInput) => server.git.push(placementId, input),
    createWorktree: (projectId: ProjectId, input: WorktreeCreateInput) =>
      server.placements.createWorktree(projectId, input),
  }
}
