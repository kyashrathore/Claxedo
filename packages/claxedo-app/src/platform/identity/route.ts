import { base64Decode, base64Encode } from "@/lib/encode"
import { asDirectoryRef, type DirectoryRef } from "./brand"

export type ShellRoute =
  | { kind: "home" }
  | { kind: "marketplace" }
  | { kind: "session"; sessionId: string }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "workspace-session"; workspaceId: string; sessionId?: string }
  | { kind: "workspace-page"; workspaceId: string; pageId: string }
  | { kind: "workspace-terminal"; workspaceId: string; terminalId: string }
  | { kind: "legacy-directory"; directory: DirectoryRef; sessionId?: string; pageId?: string; terminalId?: string }
  | { kind: "unknown" }

const RESERVED_ROOTS = new Set(["config", "login", "marketplace", "permissions", "s", "w"])

function segment(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

function pathSegments(pathname: string) {
  return pathname.split(/[?#]/, 1)[0]?.split("/").filter(Boolean) ?? []
}

function decodedWorkspaceRoute(parts: string[]): ShellRoute | undefined {
  const marker = parts.findIndex((part) => part === "session" || part === "page" || part === "terminal")
  if (marker <= 2) return
  const workspaceId = `/${parts.slice(1, marker).map(segment).join("/")}`
  const id = parts[marker + 1] ? segment(parts[marker + 1]!) : undefined
  if (parts[marker] === "session") return { kind: "workspace-session", workspaceId, ...(id ? { sessionId: id } : {}) }
  if (!id) return
  return parts[marker] === "page"
    ? { kind: "workspace-page", workspaceId, pageId: id }
    : { kind: "workspace-terminal", workspaceId, terminalId: id }
}

export function sessionRoute(sessionId: string) {
  return `/s/${encodeURIComponent(sessionId)}`
}

export function workspaceRoute(workspaceId: string) {
  return `/w/${encodeURIComponent(workspaceId)}`
}

export function marketplaceRoute() {
  return "/marketplace"
}

export function workspaceSessionRoute(workspaceId: string, sessionId?: string) {
  const base = `${workspaceRoute(workspaceId)}/session`
  return sessionId ? `${base}/${encodeURIComponent(sessionId)}` : base
}

export function workspacePageRoute(workspaceId: string, pageId: string) {
  return `${workspaceRoute(workspaceId)}/page/${encodeURIComponent(pageId)}`
}

export function workspaceTerminalRoute(workspaceId: string, terminalId: string) {
  return `${workspaceRoute(workspaceId)}/terminal/${encodeURIComponent(terminalId)}`
}

export function legacyDirectoryRouteKey(directory: string) {
  return base64Encode(directory)
}

export function legacyDirectoryFromRouteKey(value: string): DirectoryRef | undefined {
  try {
    const directory = base64Decode(value)
    if (!directory) return
    if (legacyDirectoryRouteKey(directory) !== value) return
    // route.ts is a sanctioned directory mint owner (see `brand.ts`).
    return asDirectoryRef(directory)
  } catch {
    return undefined
  }
}

export function parseShellRoute(pathname: string): ShellRoute {
  const parts = pathSegments(pathname)
  if (parts.length === 0) return { kind: "home" }
  if (parts.length === 1 && parts[0] === "marketplace") return { kind: "marketplace" }
  if (parts[0] === "s" && parts[1]) return { kind: "session", sessionId: segment(parts[1]) }
  if (parts[0] === "w" && parts[1]) {
    if (parts.length === 2) return { kind: "workspace", workspaceId: segment(parts[1]) }
    if ((parts.length === 3 || parts.length === 4) && parts[2] === "session") {
      return {
        kind: "workspace-session",
        workspaceId: segment(parts[1]),
        ...(parts[3] ? { sessionId: segment(parts[3]) } : {}),
      }
    }
    if (parts.length === 4 && parts[2] === "page" && parts[3]) {
      return {
        kind: "workspace-page",
        workspaceId: segment(parts[1]),
        pageId: segment(parts[3]),
      }
    }
    if (parts.length === 4 && parts[2] === "terminal" && parts[3]) {
      return {
        kind: "workspace-terminal",
        workspaceId: segment(parts[1]),
        terminalId: segment(parts[3]),
      }
    }
    return decodedWorkspaceRoute(parts) ?? { kind: "unknown" }
  }
  if (RESERVED_ROOTS.has(parts[0]!)) return { kind: "unknown" }

  const directory = legacyDirectoryFromRouteKey(parts[0]!)
  if (directory) {
    return {
      kind: "legacy-directory",
      directory,
      ...(parts[1] === "session" && parts[2] ? { sessionId: segment(parts[2]) } : {}),
      ...(parts[1] === "page" && parts[2] ? { pageId: segment(parts[2]) } : {}),
      ...(parts[1] === "terminal" && parts[2] ? { terminalId: segment(parts[2]) } : {}),
    }
  }
  return { kind: "unknown" }
}

// WP-D5: the sole type-erasure seam of the route layer. It collapses the tagged
// `ShellRoute` union into a single scope key that every consumer treats as the
// active *directory* (`routeDir` / directory-session-cache key / worktree
// compare). For `/w/:workspaceId` routes carrying a genuine control-plane id the
// value is still consumed as a directory-shaped scope key pending the separate
// server-side directory-shape routing fix (plan 2026-07-09-001); until that
// lands the seam is honestly typed `DirectoryRef` — the sense all downstream code
// actually uses — rather than the misleading `workspaceId` name it once carried.
// The route parser is a sanctioned directory mint owner (see `brand.ts`).
export function shellRouteDirectory(route: ShellRoute): DirectoryRef | undefined {
  switch (route.kind) {
    case "workspace":
    case "workspace-session":
    case "workspace-page":
    case "workspace-terminal":
      return asDirectoryRef(route.workspaceId)
    case "legacy-directory":
      return asDirectoryRef(route.directory)
    default:
      return undefined
  }
}

export function shellRouteDirectoryFromPathname(pathname: string): DirectoryRef | undefined {
  return shellRouteDirectory(parseShellRoute(pathname))
}

export async function resolveLegacyRedirect(
  pathname: string,
  resolveWorkspace: (input: { directory: DirectoryRef }) => Promise<{ workspaceId?: string | null } | null | undefined>,
) {
  const parsed = parseShellRoute(pathname)
  if (parsed.kind !== "legacy-directory") return
  if (parsed.sessionId) return

  const resolved = await resolveWorkspace({ directory: parsed.directory }).catch(() => undefined)
  if (!resolved?.workspaceId) return
  if (parsed.pageId) return workspacePageRoute(resolved.workspaceId, parsed.pageId)
  if (parsed.terminalId) return workspaceTerminalRoute(resolved.workspaceId, parsed.terminalId)
  return workspaceRoute(resolved.workspaceId)
}
