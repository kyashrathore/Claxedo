import { localWorkspaceAssociationId } from "@/platform/identity/legacy-resolver"
import { workspaceRouteIdentity, type WorkspaceRouteProject } from "@/platform/identity/workspace-route"

/**
 * Resolve the directory a `/w/:key` route's requests are scoped by.
 *
 * The catalog is the authority and always wins: it answers a filesystem path
 * for a workspace this server embeds and a `workspace:<id>` address for one
 * reached through the relay, never the serving host's own path. A key the
 * catalog cannot place stands in for itself, with one carve-out: a bare local
 * association UUID must wait for the catalog — using it as `?directory=` makes
 * OpenCode 404 with `workspace_not_found`.
 */
export function resolveWorkspaceRouteDirectory(input: {
  routeKey: string | undefined
  projects: readonly WorkspaceRouteProject[]
}): string | undefined {
  const identity = workspaceRouteIdentity(input.projects, input.routeKey)
  if (identity?.directory) return identity.directory
  const key = input.routeKey?.trim()
  if (!key) return undefined
  if (localWorkspaceAssociationId(key)) return undefined
  return key
}
