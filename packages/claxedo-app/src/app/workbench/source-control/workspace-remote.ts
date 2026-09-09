import { createMemo, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useShellQueryOptions } from "@/app/integrations/sync/query-options"
import { emptySessionInventory, sessionInventoryQueryOptions } from "../../../features/session/data/sync/queries"
import type { SessionInventoryRow } from "../../../features/session/data/query/types"
import { projectWorkspaceForRef } from "@/platform/identity/project-workspace"
import { projectForDirectory } from "@/platform/runtime/agent/project-owner"
import { parseOwnerRepo } from "../rail/rail-git-remote"

/**
 * The git remote of one workspace directory, from the two places the app
 * already holds it: the session inventory's per-session `git.remote` (what the
 * rail labels projects from) and the workspace catalog's `repo_url` /
 * `git.remote`. Neither is a request; both are cache reads.
 */
export function useWorkspaceRemoteUrl(input: {
  baseUrl: Accessor<string>
  directory: Accessor<string>
  workspaceId: Accessor<string | undefined>
}) {
  const queryOptions = useShellQueryOptions()
  const projects = useQuery(() => queryOptions.projects())
  const inventory = useQuery(() => sessionInventoryQueryOptions({ baseUrl: input.baseUrl() }))

  return createMemo(() => {
    const directory = input.directory()
    const workspaceId = input.workspaceId()
    const sessions = (inventory.data ?? emptySessionInventory()).sessions
    const fromSession = sessions.find(
      (session) =>
        !!session.git?.remote &&
        (session.directory === directory || (workspaceId !== undefined && session.workspaceId === workspaceId)),
    )?.git?.remote
    if (fromSession) return fromSession
    const project = projectForDirectory(projects.data ?? [], directory)
    const entry = projectWorkspaceForRef(project?.workspaces, workspaceId ?? directory)
    return entry?.repo_url ?? entry?.git_remote ?? project?.git?.remote ?? undefined
  })
}

const GITHUB_HOST = /(^|[@/.])github\.com[:/]/

/** `owner/repo` when the remote lives on GitHub, else undefined. */
export function githubOwnerRepo(remote: string | undefined) {
  if (!remote || !GITHUB_HOST.test(remote)) return
  return parseOwnerRepo(remote)
}

export function githubCompareUrl(input: { ownerRepo: string; base: string; head: string }) {
  return `https://github.com/${input.ownerRepo}/compare/${encodeURIComponent(input.base)}...${encodeURIComponent(input.head)}?expand=1`
}
