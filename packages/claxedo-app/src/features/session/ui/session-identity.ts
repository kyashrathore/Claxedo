import type { SessionRef } from "@/platform/identity/session-ref"
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

export function resolveSessionDirectory(input: {
  routeDirectory: string
  sessionRef?: SessionRef
  inventoryDirectory?: string
}) {
  if (input.sessionRef?.toolSandbox?.kind === "local") return input.sessionRef.toolSandbox.cwd
  const refDirectory = input.sessionRef?.cwd
  // `workspace:<id>` is a routing identity during draft handoff, not the
  // conversation registry's filesystem scope. Once inventory resolves the
  // canonical runtime directory, every transcript producer and consumer must
  // use that one key.
  const refIsWorkspaceIdentity = refDirectory
    ? sessionWorkspaceRuntimeRef({ directory: refDirectory }) !== undefined
    : false
  if (refDirectory && !refIsWorkspaceIdentity) return refDirectory
  if (input.inventoryDirectory) return input.inventoryDirectory
  if (refDirectory) return refDirectory
  return input.routeDirectory
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
