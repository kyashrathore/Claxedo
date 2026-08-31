import type { SessionRef } from "@/platform/identity/session-ref"
import { parseShellRoute } from "@/platform/identity/route"
import { centralTransportForServer } from "@/platform/runtime/transport"
import { USER_HOSTED_WORKSPACE_KIND } from "@/platform/runtime/agent/workspace-kind"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"

export type SessionIdentity = {
  id?: string
  scope: "pane"
  directory?: string
  surfaceId?: string
}

export function resolveSessionIdentity(input: {
  previous?: SessionIdentity
  pane?: {
    id?: string
    directory: string
    surfaceId?: string
  }
}): SessionIdentity {
  const next = {
    id: input.pane?.id,
    scope: "pane" as const,
    directory: input.pane?.directory,
    surfaceId: input.pane?.surfaceId,
  }
  if (input.pane?.id && input.pane.id !== "new") return next
  if (
    input.pane &&
    !input.pane.id &&
    input.previous &&
    input.previous.id &&
    input.previous.id !== "new" &&
    input.previous.directory === input.pane.directory &&
    input.previous.surfaceId === input.pane.surfaceId
  ) {
    return input.previous
  }
  return next
}

/**
 * Return route authority only for an actual workspace identity. The parser can
 * still receive old directory-shaped inbound links, but no current producer
 * writes those links; they must never authorize signed workspace transport.
 */
export function signedRouteSessionWorkspaceId(
  pathname: string,
  projects?: Parameters<typeof sessionWorkspaceRuntimeRef>[0]["projects"],
) {
  const route = parseShellRoute(pathname)
  if (route.kind !== "workspace-session") return undefined
  return sessionWorkspaceRuntimeRef({ directory: route.workspaceId, projects })?.workspaceId
}

/**
 * Decide whether this pane has canonical signed transport authority.
 *
 * Principal state alone is insufficient on loopback: mock/local browser tests
 * can carry a synthetic signed principal while their filesystem workspace is
 * still Local Personal Mode. Conversely, an explicit `/w/:workspaceId` route
 * or signed project/session backing already identifies the relay target before
 * principal hydration settles; the relay endpoint remains the authorization
 * gate for the request itself.
 */
export function sessionSignedTransportAuthority(input: {
  serverUrl?: string
  principalHasSignedAccess: boolean
  routeWorkspaceAuthorityId?: string
  workspaceKind?: string
  sessionRef?: SessionRef
}) {
  if (input.routeWorkspaceAuthorityId) return true
  if (input.workspaceKind === "cloud" || input.workspaceKind === USER_HOSTED_WORKSPACE_KIND) return true
  if (input.sessionRef?.host === "central") return true
  if (input.sessionRef?.toolSandbox?.kind === "workspace") return true
  return input.principalHasSignedAccess && centralTransportForServer(input.serverUrl) !== "loopback"
}

export function resolveSignedSessionWorkspaceId(input: {
  signedControlPlane: boolean
  routeDirectory?: string
  inventoryWorkspaceId?: string
  projectWorkspaceId?: string
  workspaceId?: string
}) {
  if (!input.signedControlPlane) return undefined
  return input.routeDirectory ??
    input.inventoryWorkspaceId ??
    input.projectWorkspaceId ??
    input.workspaceId
}

export function signedProjectWorkspaceId(input: {
  signedWorkspace?: { workspaceId?: string }
  workspace?: { id?: string; workspaceId?: string; kind?: string }
}) {
  if (input.signedWorkspace?.workspaceId) return input.signedWorkspace.workspaceId
  if (input.workspace?.kind === "cloud" || input.workspace?.kind === "user-hosted") {
    return input.workspace.workspaceId ?? input.workspace.id
  }
  return undefined
}
