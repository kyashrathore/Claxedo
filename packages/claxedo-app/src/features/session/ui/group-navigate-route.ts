import { parseShellRoute, shellRouteDirectory, shellRouteDirectoryFromPathname } from "@/platform/identity/route"

/**
 * Same-pane group navigation URL sync.
 *
 * `groupNavigate` performs workspace-bearing navigations (project switch, new
 * worktree, workspace-session root) IN-PANE via `layout.openSession(...)` so the
 * focused pane retargets without a remount. The reverse `surface → URL` sync
 * (`app-shell-route-sync.ts`) deliberately refuses to touch `session`/`workspace`
 * kind routes, so an in-pane switch into a different workspace leaves
 * the URL pinned to the previous workspace. A reload on that stale URL would then
 * restore the wrong surface — the pane-active state and the URL disagree.
 *
 * This decides whether the in-pane navigation also needs an explicit URL sync: it
 * returns the target path (to `navigate(_, { replace: true })`) only when the
 * target route carries a workspace key that differs from the URL's current key.
 * Returning `undefined` means the URL is already on the target's workspace, so the
 * in-pane retarget alone is enough — no navigate, no remount.
 */
export function groupNavigateUrlSync(input: {
  targetPath: string
  currentPathname: string
}): string | undefined {
  const targetDir = shellRouteDirectory(parseShellRoute(input.targetPath))
  if (!targetDir) return undefined
  const currentDir = shellRouteDirectoryFromPathname(input.currentPathname)
  if (targetDir === currentDir) return undefined
  return input.targetPath
}

/**
 * Resolve the physical directory written into retained pane state.
 *
 * Canonical `/w/:workspaceId` routes carry identity, not a cwd. Callers that
 * intentionally switch workspaces therefore carry the selected directory next
 * to the route. Legacy inbound routes are the sole route shape that still owns
 * a physical directory and may recover it from the URL.
 */
export function groupNavigateDirectory(input: {
  targetPath: string
  currentDirectory: string
  targetDirectory?: string
}) {
  if (input.targetDirectory) return input.targetDirectory
  const route = parseShellRoute(input.targetPath)
  if (route.kind === "legacy-directory") return route.directory
  return input.currentDirectory
}
