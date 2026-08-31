import { isFilesystemDirectory } from "@/platform/identity/legacy-resolver"
import { isLoopbackHttpUrl } from "@/platform/api/api"

export { isLoopbackHttpUrl } from "@/platform/api/api"

// True only for Local Personal Mode: loopback server plus a real local
// workspace directory. Cloud workspaces pass workspaceId separately.
export function isLocalPersonalScope(input: { serverUrl?: string; directory?: string }) {
  return isLoopbackHttpUrl(input.serverUrl) && isFilesystemDirectory(input.directory)
}

export function centralTransportForServer(serverUrl: string | undefined) {
  return isLocalPersonalScope({ serverUrl, directory: "/" }) ? "loopback" : "signed-web"
}
