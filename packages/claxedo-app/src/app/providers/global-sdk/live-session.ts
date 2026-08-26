import { createSdkForServer } from "@/app/connection/server-client"
import { signedWorkspaceFromProjects } from "@/platform/runtime/agent/signed-workspace"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import type { LiveSession } from "../global-sdk-event-fetch"

export const USER_HOSTED_WORKSPACE_KIND = "user-hosted"

export type GlobalSdkClientOptions = Omit<Parameters<typeof createSdkForServer>[0], "server" | "fetch"> & {
  workspaceId?: string
}
type WorkspaceProjects = Parameters<typeof signedWorkspaceFromProjects>[0]

export function nextLiveSession(
  current: LiveSession | undefined,
  sessionID: string,
  opts?: { host?: "central" | "workspace"; directory?: string; workspaceId?: string; workspaceKind?: string },
) {
  const sameScope =
    !!current &&
    (opts?.host === undefined || opts.host === current.host) &&
    (opts?.directory === undefined || opts.directory === current.directory) &&
    (opts?.workspaceId === undefined || opts.workspaceId === current.workspaceId)
  return {
    sessionID,
    host: opts?.host ?? (sameScope ? current?.host : undefined),
    directory: opts?.directory ?? (sameScope ? current?.directory : undefined),
    workspaceId: opts?.workspaceId ?? (sameScope ? current?.workspaceId : undefined),
    workspaceKind: opts?.workspaceKind ?? (sameScope ? current?.workspaceKind : undefined),
  }
}

export function liveSessionTransition(
  current: LiveSession | undefined,
  sessionID: string,
  opts?: { host?: "central" | "workspace"; directory?: string; workspaceId?: string; workspaceKind?: string },
) {
  const next = nextLiveSession(current, sessionID, opts)
  const workspaceScopeChanged =
    next.host !== current?.host ||
    next.directory !== current?.directory ||
    next.workspaceId !== current?.workspaceId ||
    next.workspaceKind !== current?.workspaceKind
  return {
    next,
    workspaceScopeChanged,
    runtimeStreamChanged: workspaceScopeChanged || next.sessionID !== current?.sessionID,
  }
}

export function eventDirectoryForLiveSession(input: { directory: string; liveSession?: LiveSession }): string {
  if (input.directory === "global") return input.directory
  if (input.liveSession?.workspaceId) return input.liveSession.workspaceId
  const legacyDirectory = input.liveSession?.directory
  const workspaceId = legacyDirectory
    ? sessionWorkspaceRuntimeRef({ directory: legacyDirectory })?.workspaceId
    : undefined
  if (workspaceId) return workspaceId
  return input.directory
}

export function globalSdkClientWorkspaceId(
  projects: WorkspaceProjects,
  input: Pick<GlobalSdkClientOptions, "directory" | "workspaceId">,
) {
  const explicitWorkspaceId = input.workspaceId?.trim()
  if (explicitWorkspaceId) {
    return signedWorkspaceFromProjects(projects, explicitWorkspaceId)?.workspaceId ?? explicitWorkspaceId
  }
  return signedWorkspaceFromProjects(projects, input.directory)?.workspaceId
}

export function globalSdkClientPlacement(workspaceId?: string) {
  const resolved = workspaceId?.trim()
  if (!resolved) return
  return {
    workspaceId: resolved,
    hosting: "workspace",
    transport: "workspace-relay",
  } as const
}

export function liveSessionWithRelayBacking(session: LiveSession, projects: WorkspaceProjects) {
  if (session.workspaceId && session.workspaceKind) return session
  if (session.workspaceId) {
    const ref = sessionWorkspaceRuntimeRef({ directory: session.workspaceId, projects })
    return { ...session, workspaceKind: ref?.kind ?? USER_HOSTED_WORKSPACE_KIND }
  }
  if (!session.directory) return session
  const ref = sessionWorkspaceRuntimeRef({ directory: session.directory, projects })
  if (!ref) return session
  return { ...session, workspaceId: ref.workspaceId, workspaceKind: ref.kind }
}

/**
 * Runtime events are scoped to one real parent session. The workspace-route
 * sentinel used by the global lifecycle stream is not an authorized parent
 * and must never be sent as `parentSessionId` to a Workspace Runtime.
 */
export function runtimeEventLiveSession(current: LiveSession | undefined, projects: WorkspaceProjects) {
  if (!current || current.sessionID === "route") return
  return liveSessionWithRelayBacking(current, projects)
}
