import { queryClient } from "@/platform/query/query-client"
import { type WorkspaceRuntimeSnapshot, workspaceResolveQuery } from "@/platform/runtime/workspace-query"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { fastSessionSwitchAnyNetworkQuiet } from "@/platform/runtime/session-switch"

/**
 * Reading the workspace runtime RECORD — which workspace a directory belongs
 * to, what kind it is, and whether it is still coming up.
 *
 * This is not a hosted capability, which is why it does not live under
 * `runtime/cloud/`. The record is served by `http-backend.ts` for every
 * deployment; a local build simply gets `null` (no workspace for the
 * directory, or a 404 from the resolve route) and every caller already handles
 * that. What made it LOOK hosted was its address: it shipped inside
 * `platform/runtime/cloud/workspace-runtime-store.ts`, so fourteen local
 * files — bootstrap, the rail, terminals, processes, review, the session
 * composer and harness — imported a module the cloud extraction has to move.
 *
 * Provisioning a cloud sandbox or connecting a user-hosted host IS a hosted
 * capability, and that half stays behind `workspace-startup-port.ts`. The line
 * between the two files is "read the record" versus "make the runtime exist".
 */

/**
 * Collapse a `{ directory, workspaceId }` pair to whichever one identifies the
 * runtime, so a directory that is really a workspace ref resolves by id.
 */
export function runtimeScope(input: { directory?: string; workspaceId?: string }) {
  const workspaceId = input.workspaceId ??
    (input.directory ? sessionWorkspaceRuntimeRef({ directory: input.directory })?.workspaceId : undefined)
  return {
    workspaceId,
    directory: workspaceId ? undefined : input.directory,
  }
}

export function pendingCloudRuntime(
  input: WorkspaceRuntimeSnapshot | null | undefined,
): input is WorkspaceRuntimeSnapshot & { kind: "cloud"; status: string } {
  return !!input && input.kind === "cloud" && !!input.status && input.status !== "ready" && input.status !== "failed"
}

export function workspaceRuntimeBlocksBootstrap(input?: WorkspaceRuntimeSnapshot | null) {
  return pendingCloudRuntime(input)
}

export async function resolveWorkspaceRuntime(input: {
  baseUrl?: string
  request?: typeof fetch
  directory?: string
  workspaceId?: string
  create?: boolean
}) {
  const query = workspaceResolveQuery({
    ...input,
    ...runtimeScope(input),
  })
  if (fastSessionSwitchAnyNetworkQuiet() && input.directory && !input.workspaceId && input.create !== true) {
    const cached = queryClient.getQueryData<WorkspaceRuntimeSnapshot | null>(query.queryKey)
    if (cached !== undefined) return cached
    return null
  }
  return await queryClient.fetchQuery(query)
}
