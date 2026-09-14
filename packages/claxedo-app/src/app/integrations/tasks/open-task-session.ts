import { useNavigate } from "@solidjs/router"
import { useQuery } from "@tanstack/solid-query"
import type { SessionReference } from "@claxedo/tasks"
import { useShellQueryOptions } from "@/app/integrations/sync/query-options"
import { useClaxedoState } from "@/app/workbench/state/index"
import { sessionRoute, workspaceSessionRoute } from "@/platform/identity/route"
import { workspaceBackedSessionRef } from "@/platform/identity/session-ref"

/**
 * Open a linked session through ordinary session navigation.
 *
 * The link carries the durable `{ sessionId, workspaceId }` the server owns.
 * The app's `SessionRef` is built from it here rather than stored, and the
 * workspace's hosting is read from the project inventory — the same authority
 * the rail reads — so a Tasks record never becomes a second, stale source for
 * where a session runs.
 */
export function useOpenTaskSession() {
  const state = useClaxedoState()
  const queryOptions = useShellQueryOptions()
  const projects = useQuery(() => queryOptions.projects())
  const navigate = useNavigate()

  // `SandboxRef` names only the two hosted kinds, so the inventory answer is
  // narrowed to them: a workspace the control plane runs is cloud, and anything
  // else reachable by workspace id is served by a host.
  const hostingOf = (id: string) => {
    const inventory = (projects.data ?? []).flatMap((project) => Object.values(project.workspaces ?? {}))
    const workspace = inventory.find((entry) => entry.workspaceId === id || entry.id === id)
    return workspace?.kind === "cloud" ? ("cloud" as const) : ("user-hosted" as const)
  }

  return (session: SessionReference) => {
    const workspaceId = session.workspaceId ?? undefined
    const sessionRef = workspaceId
      ? workspaceBackedSessionRef({ sessionId: session.sessionId, workspace: { workspaceId, kind: hostingOf(workspaceId) } })
      : undefined
    state.layout.openSessionById(session.sessionId, undefined, sessionRef ? { sessionRef } : undefined)
    navigate(workspaceId ? workspaceSessionRoute(workspaceId, session.sessionId) : sessionRoute(session.sessionId))
  }
}
