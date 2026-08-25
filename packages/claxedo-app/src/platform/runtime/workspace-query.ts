import type { VcsInfo } from "@opencode-ai/sdk/v2/client"
import { queryKeys } from "@/platform/query/keys"
import { createHttpWorkspaceRuntimeBackend } from "@/platform/runtime/http-backend"
import type { WorkspaceRuntimeSnapshot } from "@/platform/runtime/workspace-runtime"
export type { WorkspaceRuntimeSnapshot } from "@/platform/runtime/workspace-runtime"

type VcsClient = {
  vcs: {
    get: () => Promise<{ data?: VcsInfo }>
  }
}

/**
 * The workspace's VCS summary (branch, default branch) for one directory.
 *
 * Freshness is EVENT-owned, not wall-clock-owned: `WorkspaceVcsCacheHonesty`
 * (app/workbench/context) holds one ref-counted subscription per worktree and
 * invalidates `queryKeys.runtime.vcs` when the runtime reports a HEAD/refs
 * write or a `vcs.branch.updated`, reconciling once after any window in which
 * nobody was listening. A wall clock cannot know when a branch changed; all it
 * did was make whichever surface observed the entry first after expiry pay a
 * refetch. On a same-workspace session switch that was a runtime VCS status
 * call plus the workspace-record resolve behind it, landing on a different
 * pane each run — the flapping stability gate this staleTime replaces.
 */
export function workspaceVcsQuery(input: {
  baseUrl?: string
  directory: string
  request?: typeof fetch
  client: VcsClient
  signedControlPlane?: boolean
  workspaceId?: string
  workspace?: WorkspaceRuntimeSnapshot | null
}) {
  const backend = createHttpWorkspaceRuntimeBackend({
    baseUrl: input.baseUrl,
    request: input.request,
    client: input.client,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    workspace: input.workspace,
  })
  return {
    queryKey: queryKeys.runtime.vcs(input.baseUrl, input.directory, input.workspaceId),
    staleTime: Infinity,
    queryFn: async () => await backend.getVcs({ directory: input.directory }),
  }
}
