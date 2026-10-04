import type { SignedControlPlaneAuth } from "../platform/auth/auth"
import { requireAuthority, type ProjectAction, type WorkspaceAuthority } from "../platform/auth/authority"
import { asProjectId } from "../platform/auth/branded-id"

/** One caller's reach over the projects a server stores. */
export type ProjectAccess = {
  allowed: (projectId: string, action: ProjectAction) => Promise<boolean>
}

/**
 * The one authorization operation for a server's projects. Each route family
 * extracts the caller its own way — the local shell routes authenticate the
 * request inline, `/api/claxedo/projects` through its `authenticate` option —
 * and both decide reach here.
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
  if (!auth) return { allowed: async () => true }
  const authority = requireAuthority(services)
  return {
    allowed: async (projectId, action) =>
      (await authority.authorizeProject(auth, { projectId: asProjectId(projectId), action })).ok,
  }
}
