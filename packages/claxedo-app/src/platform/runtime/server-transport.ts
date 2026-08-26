import { isFilesystemDirectory } from "@/platform/identity/legacy-resolver"

export function isLoopbackHttpUrl(input: string | undefined) {
  if (!input) return false
  try {
    const url = new URL(input)
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "::1" ||
        url.hostname === "[::1]")
    )
  } catch {
    return false
  }
}

// True only for Local Personal Mode: loopback server plus a real local
// workspace directory. Cloud workspaces pass workspaceId separately.
export function isLocalPersonalScope(input: { serverUrl?: string; directory?: string }) {
  return isLoopbackHttpUrl(input.serverUrl) && isFilesystemDirectory(input.directory)
}

export function centralTransportForServer(serverUrl: string | undefined) {
  return isLocalPersonalScope({ serverUrl, directory: "/" }) ? "loopback" : "signed-web"
}
