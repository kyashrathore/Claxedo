import { createServerClient } from "@/app/connection/server-client"
import { localWorkspaceInProjects, signedWorkspaceFromProjects } from "@/platform/runtime/agent/signed-workspace"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import type { SessionRef } from "@/platform/identity/session-ref"

/** The session whose frames the streams are open for, as this app addresses it. */
export type LiveSession = {
  sessionID: string
  host?: "workspace"
  directory?: string
  workspaceId?: string
  hostKind?: string
  sessionRef?: SessionRef
}

export type GlobalSdkClientOptions = Omit<Parameters<typeof createServerClient>[0], "server" | "request"> & {
  workspaceId?: string
  request?: typeof fetch
}
type WorkspaceProjects = Parameters<typeof signedWorkspaceFromProjects>[0]

export function nextLiveSession(
  current: LiveSession | undefined,
  sessionID: string,
  opts?: { host?: "workspace"; directory?: string; workspaceId?: string; hostKind?: string; sessionRef?: SessionRef },
) {
  const sameScope = !!current &&
    (opts?.host === undefined || opts.host === current.host) &&
    (opts?.directory === undefined || opts.directory === current.directory) &&
    (opts?.workspaceId === undefined || opts.workspaceId === current.workspaceId)
  return {
    sessionID,
    host: opts?.host ?? (sameScope ? current?.host : undefined),
    directory: opts?.directory ?? (sameScope ? current?.directory : undefined),
    workspaceId: opts?.workspaceId ?? (sameScope ? current?.workspaceId : undefined),
    hostKind: opts?.hostKind ?? (sameScope ? current?.hostKind : undefined),
    sessionRef: opts?.sessionRef ?? (sameScope ? current?.sessionRef : undefined),
  }
}

export function liveSessionTransition(
  current: LiveSession | undefined,
  sessionID: string,
  opts?: { host?: "workspace"; directory?: string; workspaceId?: string; hostKind?: string; sessionRef?: SessionRef },
) {
  const next = nextLiveSession(current, sessionID, opts)
  const workspaceScopeChanged =
    next.host !== current?.host ||
    next.directory !== current?.directory ||
    next.workspaceId !== current?.workspaceId ||
    next.hostKind !== current?.hostKind
  return { next, workspaceScopeChanged }
}

/**
 * The workspace a client must be RELAY-ROUTED to, or `undefined` for "talk to
 * the server directly with `?directory=`".
 *
 * Every claxedo workspace carries a uuid, the ones this server serves
 * included, so an explicit `workspaceId` from a session row is not by itself
 * evidence of a relay. The inventory is the authority: a signed, relay-placed
 * workspace routes through the relay, one the inventory places on this server
 * never does, and an id the inventory cannot place yet keeps the optimistic
 * fallback — that is what lets a relay-placed workspace work before its
 * projects have loaded.
 *
 * Without the placed-here rule, the rows of a workspace this server serves
 * itself route at the relay and every request answers `401 Workspace connection
 * failed`, which the SDK reports as `data: undefined`. Callers that read absence
 * as an assertion (the rail's status batch: absent from `/session/status` means
 * idle) then read a request that never reached the runtime as "this session is
 * idle".
 */
export function globalSdkClientWorkspaceId(
  projects: WorkspaceProjects,
  input: Pick<GlobalSdkClientOptions, "directory" | "workspaceId">,
) {
  const explicitWorkspaceId = input.workspaceId?.trim()
  if (explicitWorkspaceId) {
    const signed = signedWorkspaceFromProjects(projects, explicitWorkspaceId)
    if (signed) return signed.workspaceId
    if (localWorkspaceInProjects(projects, explicitWorkspaceId)) return undefined
    return explicitWorkspaceId
  }
  return signedWorkspaceFromProjects(projects, input.directory)?.workspaceId
}

export function globalSdkClientPlacement(workspaceId?: string) {
  const resolved = workspaceId?.trim()
  if (!resolved) return undefined
  return {
    workspaceId: resolved,
    hosting: "workspace",
    transport: "workspace-relay",
  } as const
}

export function liveSessionWithRelayBacking(session: LiveSession, projects: WorkspaceProjects) {
  if (session.workspaceId && session.hostKind) return session
  if (session.workspaceId) {
    const ref = sessionWorkspaceRuntimeRef({ directory: session.workspaceId, projects })
    return { ...session, hostKind: ref?.kind ?? "machine" }
  }
  if (!session.directory) return session
  const ref = sessionWorkspaceRuntimeRef({ directory: session.directory, projects })
  if (!ref) return session
  return { ...session, workspaceId: ref.workspaceId, hostKind: ref.kind }
}
