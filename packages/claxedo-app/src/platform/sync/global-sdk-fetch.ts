// target-layer: data
import { createTransport } from "@/platform/runtime/transport"
import { signedWorkspaceFromProjects } from "@/platform/runtime/agent/signed-workspace"
import { isFilesystemDirectory } from "@/platform/identity/legacy-resolver"
import { authFetch } from "@/platform/api/api"
import { centralTransportForServer } from "@/platform/runtime/transport"

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
      if (directory && isFilesystemDirectory(directory)) {
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
