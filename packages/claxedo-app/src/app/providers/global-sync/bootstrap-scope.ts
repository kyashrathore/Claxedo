import { shellRouteDirectoryFromPathname } from "@/platform/identity/route"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"

export function workspaceDirectoryRef(directory: string) {
  return !!sessionWorkspaceRuntimeRef({ directory })
}

export function initialRouteDirectory() {
  if (typeof window === "undefined") return
  const configured = (window as typeof window & {
    __CLAXEDO__?: { activeDirectory?: string }
  }).__CLAXEDO__?.activeDirectory
  if (configured) return configured
  return shellRouteDirectoryFromPathname(window.location.pathname)
}
