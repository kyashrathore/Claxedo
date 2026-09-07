import { queryOptions } from "@tanstack/solid-query"
import { normalizeUrl } from "@/platform/api/api"
import type { WorkspaceDiffClient } from "@/platform/runtime/workspace-diff-client"
import type { GitStatusEntry } from "@/platform/runtime/workspace-git-client"
import type { WorkspaceGitScope } from "./workspace-git-status-query"

export type WorkspaceDiffSummaryTarget = {
  mode: string
  fromRef?: string
  toRef?: string
}

/** One changed file of a diff summary, in the shape the Changes column already renders. */
export type WorkspaceDiffSummaryEntry = Pick<GitStatusEntry, "path" | "status" | "additions" | "deletions">

/** The summary family for one scope; a read's key appends its target, so this prefix invalidates every comparison. */
export function workspaceDiffSummaryKey(scope: WorkspaceGitScope) {
  return ["directory", normalizeUrl(scope.baseUrl) ?? "default", "diffSummary", scope.directoryPath, scope.workspaceKey ?? ""] as const
}

function summaryStatus(status: string | undefined): WorkspaceDiffSummaryEntry["status"] {
  if (status === "added" || status === "A") return "added"
  if (status === "deleted" || status === "D") return "deleted"
  if (status === "renamed" || status === "R") return "renamed"
  return "modified"
}

export function workspaceDiffSummaryQueryOptions(input: {
  client: Pick<WorkspaceDiffClient, "vcs">
  scope: WorkspaceGitScope
  target: WorkspaceDiffSummaryTarget
}) {
  const { mode, fromRef, toRef } = input.target
  return queryOptions({
    queryKey: [...workspaceDiffSummaryKey(input.scope), mode, fromRef ?? "", toRef ?? ""] as const,
    queryFn: async (): Promise<WorkspaceDiffSummaryEntry[]> => {
      const rows = await input.client.vcs({ directory: input.scope.directoryPath, mode, fromRef, toRef, content: "summary" })
      return rows.map((row) => ({
        path: row.file,
        status: summaryStatus(row.status),
        additions: row.additions,
        deletions: row.deletions,
      }))
    },
    // Freshness is event-owned by WorkspaceVcsCacheHonesty and by every git
    // write through useWorkspaceGitMutations, like the git-status query.
    staleTime: Number.POSITIVE_INFINITY,
  })
}
