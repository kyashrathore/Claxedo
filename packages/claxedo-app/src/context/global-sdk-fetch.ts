// target-layer: data
import { createTransport } from "@claxedo/shell/data/transport/transport"
import { signedWorkspaceFromProjects } from "../runtime/signed-workspace"
import { isLocalFilesystemDirectory } from "../shell/identity/legacy-resolver"
import { authFetch } from "../utils/api"
import { centralTransportForServer } from "@claxedo/shell/data/transport/transport"

export function createGlobalSdkFetch(input: {
  serverUrl: string
  projectInventory: () => Parameters<typeof signedWorkspaceFromProjects>[0]
  request?: typeof fetch
}): typeof fetch {
  return async (requestInput, init) => {
    const url = new URL(requestInput instanceof Request ? requestInput.url : String(requestInput), input.serverUrl)
    if (
      centralTransportForServer(input.serverUrl) !== "loopback" &&
      url.pathname === "/session"
    ) {
      const directory = url.searchParams.get("directory") ?? undefined
      if (directory && isLocalFilesystemDirectory(directory)) {
        const workspace = signedWorkspaceFromProjects(input.projectInventory(), directory)
        if (!workspace) return Response.json([])
        const request = input.request ?? authFetch
        return createTransport({
          placement: { workspaceId: workspace.workspaceId, hosting: "workspace", transport: "workspace-relay" },
          serverUrl: input.serverUrl,
          directory,
          request,
          relayRequest: request,
        }).sdkFetch(requestInput, init)
      }
    }
    return (input.request ?? authFetch)(requestInput, init)
  }
}
