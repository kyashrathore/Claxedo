import { localWorkspaceAssociationId } from "@/platform/identity/legacy-resolver"
import { workspaceRouteIdentity, type WorkspaceRouteProject } from "@/platform/identity/workspace-route"

/**
 * Resolve the session cwd for a `/w/:key` route.
 *
 * Catalog hits always win. Historical behavior is `identity?.directory ??
 * routeKey`. The only carve-out: bare local association UUIDs must wait for the
 * project catalog — using them as `?directory=` makes OpenCode 404 with
 * `workspace_not_found`.
 */
export function resolveWorkspaceRouteDirectory(input: {
  routeKey: string | undefined
  projects: readonly WorkspaceRouteProject[]
}): string | undefined {
  const identity = workspaceRouteIdentity(input.projects, input.routeKey)
  if (identity?.directory) return identity.directory
  const key = input.routeKey?.trim()
  if (!key) return
  if (localWorkspaceAssociationId(key)) return undefined
  return key
}
