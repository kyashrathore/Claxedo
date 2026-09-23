import { queryOptions } from "@tanstack/solid-query"
import type { PlacementId } from "./ids"
import { queryKeys } from "./query-keys"
import { withQuery, type Transport } from "./transport"
import type { Workspaces } from "./workspaces"

export type GitStatusEntry = {
  readonly path: string
  readonly status: "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted"
  readonly additions: number
  readonly deletions: number
  readonly from?: string
}

export type GitStatus = {
  readonly branch?: string
  readonly upstream?: string
  readonly ahead: number
  readonly behind: number
  readonly staged: readonly GitStatusEntry[]
  readonly unstaged: readonly GitStatusEntry[]
}

export type GitCommit = {
  readonly hash: string
  readonly shortHash: string
  readonly subject: string
  readonly author: string
  readonly date: string
  readonly refs: readonly string[]
  readonly parents: readonly string[]
}

const GIT_PATH = "/api/wr/git"
export const DEFAULT_LOG_LIMIT = 50

export function gitQueries(transport: Transport, workspaces: Workspaces) {
  const server = transport.serverUrl
  return {
    status: (placementId: PlacementId) => queryOptions({
      queryKey: queryKeys.gitStatus(server, placementId),
      queryFn: () => transport.runtimeJson<GitStatus>(workspaces.routeFor(placementId), `${GIT_PATH}/status`),
    }),
    log: (placementId: PlacementId, limit = DEFAULT_LOG_LIMIT) => queryOptions({
      queryKey: queryKeys.gitLog(server, placementId, limit),
      queryFn: async () => {
        const body = await transport.runtimeJson<{ commits?: unknown }>(workspaces.routeFor(placementId), withQuery(`${GIT_PATH}/log`, { limit }))
        return (Array.isArray(body.commits) ? body.commits : []) as readonly GitCommit[]
      },
    }),
  }
}
