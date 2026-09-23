import { isFilesystemDirectory } from "@/platform/identity/legacy-resolver"
import { isLoopbackHttpUrl } from "@/platform/api/api"

export { isLoopbackHttpUrl } from "@/platform/api/api"

export function isLocalPersonalScope(input: { serverUrl?: string; directory?: string }) {
  return isLoopbackHttpUrl(input.serverUrl) && isFilesystemDirectory(input.directory)
}

/**
 * Which wire reaches the central at `serverUrl`: a loopback socket this
 * machine already owns, or the network.
 *
 * A transport, not a posture. Whether that central issues sessions is its own
 * declaration (`deployment.issuesSessions` in its bootstrap body) — a signed
 * node runs its issuer on localhost too, so this answers "loopback" for it and
 * is right to.
 */
export function centralTransportForServer(serverUrl: string | undefined) {
  return isLocalPersonalScope({ serverUrl, directory: "/" }) ? "loopback" : "signed-web"
}
