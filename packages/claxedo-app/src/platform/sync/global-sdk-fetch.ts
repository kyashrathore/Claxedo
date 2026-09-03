import { createTransport } from "@/platform/runtime/transport"
import type { SignedWorkspaceInfo } from "@/platform/runtime/agent/signed-workspace"
import { isFilesystemDirectory } from "@/platform/identity/legacy-resolver"
import { authFetch } from "@/platform/api/api"
import { centralTransportForServer } from "@/platform/runtime/transport"

type WorkspaceSelector = string

export function createGlobalSdkFetch(input: {
  serverUrl: string
  resolveSignedWorkspace: (directory: WorkspaceSelector) => SignedWorkspaceInfo | undefined
  request?: typeof fetch
}): typeof fetch {
  return async (requestInput, init) => {
    const url = new URL(requestInput instanceof Request ? requestInput.url : String(requestInput), input.serverUrl)
    const request = input.request ?? authFetch
    const runtimeOwned = /^\/(session|file|config|mcp|agent|command|permission|question)(\/|$)/.test(url.pathname)
    if (runtimeOwned) {
      // Inspect headers without constructing from a body-bearing Request.
      // `new Request(requestInput, init)` transfers/locks that body, so the
      // authoritative fallback below then receives an already-used Request.
      const headers = new Headers(requestInput instanceof Request ? requestInput.headers : undefined)
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
      const directory = url.searchParams.get("directory") ?? headers.get("x-opencode-directory") ?? undefined
      if (directory) {
        const remoteControlPlane = centralTransportForServer(input.serverUrl) !== "loopback"
        const workspace = input.resolveSignedWorkspace(directory)
        // A signed inventory match is canonical placement authority even while
        // principal hydration is pending. Selecting the relay does not grant
        // access: the connection/relay endpoints still authorize the request.
        if (workspace) {
          return createTransport({
            placement: { workspaceId: workspace.workspaceId, hosting: "workspace", transport: "workspace-relay" },
            serverUrl: input.serverUrl,
            directory,
            request,
            relayRequest: request,
          }).sdkFetch(requestInput, init)
        }
        if (
          !workspace &&
          remoteControlPlane &&
          isFilesystemDirectory(directory) &&
          url.pathname === "/session" &&
          url.searchParams.has("directory")
        ) return Response.json([])
      }
    }
    return request(requestInput, init)
  }
}
