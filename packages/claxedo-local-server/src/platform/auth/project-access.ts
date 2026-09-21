import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority, type ProjectAction, type WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { asProjectId } from "@claxedo/server-core/platform/auth/branded-id"

/**
 * One caller's reach over the projects this server stores.
 *
 * `local` is the unsigned local product rather than a permission: the shell's
 * `/project/current` creates a workspace for a directory only there, because
 * only there is a directory the caller names theirs by definition.
 */
export type ProjectAccess = {
  local: boolean
  allowed: (projectId: string, action: ProjectAction) => Promise<boolean>
}

/**
 * The one authorization operation for this server's projects. Each route family
 * extracts the caller its own way — the shell routes authenticate the request
 * inline, the `/api/claxedo/projects` router reads the context its per-route
 * bearer gate already verified — and both decide reach here.
 *
 * No signed caller is the unsigned local product: one person at the keyboard,
 * no authority to ask and no account to ask about, so every project is theirs.
 * A signed caller reaches only what the authority grants, and a signed
 * composition carrying no authority reaches nothing — `requireAuthority`
 * refuses with a 503 rather than falling through to the local answer.
 */
export function projectAccess(
  auth: SignedControlPlaneAuth | undefined,
  services: { authority?: WorkspaceAuthority } | undefined,
): ProjectAccess {
  if (!auth) return { local: true, allowed: async () => true }
  const authority = requireAuthority(services)
  return {
    local: false,
    allowed: async (projectId, action) =>
      (await authority.authorizeProject(auth, { projectId: asProjectId(projectId), action })).ok,
  }
}
