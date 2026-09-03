import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { signedWorkspaceFromProjects, type SignedWorkspaceInfo, type WorkspaceInventoryProject } from "./signed-workspace"

/**
 * The signed workspace inventory's match for a directory, read straight from
 * the shared Query cache — the one `queryKeys.controlPlane.projects` entry the
 * global SDK fetch and the session/directory queries already read.
 *
 * A user-hosted workspace addressed by its filesystem-path directory has no
 * `/api/workspace/resolve` answer on the hosted control plane, so the network
 * liveness read answers null for it; the inventory is the placement authority
 * that says "this directory is workspace X, served over the relay".
 */
export function cachedSignedWorkspace(serverUrl: string, selector: string | undefined): SignedWorkspaceInfo | undefined {
  return signedWorkspaceFromProjects(
    queryClient.getQueryData<WorkspaceInventoryProject[]>(queryKeys.controlPlane.projects(serverUrl)) ?? [],
    selector,
  )
}
