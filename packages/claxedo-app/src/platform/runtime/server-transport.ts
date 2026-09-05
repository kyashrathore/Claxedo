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

/**
 * The central transport for the deployment the app was built against.
 *
 * A loopback URL alone says "this machine's own server", which has no accounts
 * in the local product. A build with auth enabled is talking to a server that
 * issues sessions — the self-hosted server with its embedded issuer runs on
 * localhost too — so that build is signed web wherever the server lives.
 */
export function centralTransportForDeployment(input: { serverUrl: string | undefined; authEnabled: boolean }) {
  return input.authEnabled ? ("signed-web" as const) : centralTransportForServer(input.serverUrl)
}
