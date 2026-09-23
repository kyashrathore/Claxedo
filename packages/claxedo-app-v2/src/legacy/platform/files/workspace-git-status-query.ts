import { queryOptions } from "@tanstack/solid-query"
import { normalizeUrl } from "@/platform/api/api"
import type { WorkspaceGitClient } from "@/platform/runtime/workspace-git-client"

/** The same identity the file-status query carries: server, worktree, resolved workspace. */
export type WorkspaceGitScope = {
  baseUrl?: string
  directoryPath: string
  workspaceKey?: string
}

const DEFAULT_LOG_LIMIT = 50

function workspaceGitKey(scope: WorkspaceGitScope, resource: "gitStatus" | "gitLog") {
  return ["directory", normalizeUrl(scope.baseUrl) ?? "default", resource, scope.directoryPath, scope.workspaceKey ?? ""] as const
}

export function workspaceGitStatusKey(scope: WorkspaceGitScope) {
  return workspaceGitKey(scope, "gitStatus")
}

/** The log family for one scope; a read's key appends its limit, so this prefix invalidates every page size. */
export function workspaceGitLogKey(scope: WorkspaceGitScope) {
  return workspaceGitKey(scope, "gitLog")
}

export function workspaceGitStatusQueryOptions(input: { git: WorkspaceGitClient; scope: WorkspaceGitScope }) {
  return queryOptions({
    queryKey: workspaceGitStatusKey(input.scope),
    queryFn: () => input.git.status(),
    // Freshness is event-owned by WorkspaceVcsCacheHonesty and by every git
    // write through useWorkspaceGitMutations, like the file-status query.
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function workspaceGitLogQueryOptions(input: { git: WorkspaceGitClient; scope: WorkspaceGitScope; limit?: number }) {
  const limit = input.limit ?? DEFAULT_LOG_LIMIT
  return queryOptions({
    queryKey: [...workspaceGitLogKey(input.scope), limit] as const,
    queryFn: () => input.git.log({ limit }).then((result) => result.commits),
    staleTime: Number.POSITIVE_INFINITY,
  })
}
