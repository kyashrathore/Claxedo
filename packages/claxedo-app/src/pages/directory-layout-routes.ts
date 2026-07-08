import { workspaceResolveUrl as controlWorkspaceResolveUrl } from "@claxedo/utils/workspace-control-routes"
export { isLocalPersonalScope } from "@claxedo/shell/data/transport/transport"

export function workspaceResolveUrl(input: { serverUrl?: string; directory?: string; workspaceId?: string }) {
  return new URL(controlWorkspaceResolveUrl({
    baseUrl: input.serverUrl,
    scope: input.directory,
    workspaceId: input.workspaceId,
  }))
}
