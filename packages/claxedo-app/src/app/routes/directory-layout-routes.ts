import { decode64 } from "@/lib/base64"
import { asDirectoryRef, type DirectoryRef } from "@/platform/identity/brand"
import { workspaceResolveUrl as controlWorkspaceResolveUrl } from "@/platform/runtime/agent/workspace-control-routes"
export { isLocalPersonalScope } from "@/platform/runtime/transport"

export function decodeDirectory(dir: string): DirectoryRef | undefined {
  const decoded = decode64(dir)
  if (!decoded) return
  return asDirectoryRef(decoded)
}

export function workspaceResolveUrl(input: { serverUrl?: string; directory?: string; workspaceId?: string }) {
  return new URL(controlWorkspaceResolveUrl({
    baseUrl: input.serverUrl,
    scope: input.directory,
    workspaceId: input.workspaceId,
  }))
}
