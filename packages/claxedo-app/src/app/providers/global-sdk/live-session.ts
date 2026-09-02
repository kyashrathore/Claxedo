import { createSdkForServer } from "@/app/connection/server-client"
import { sessionRowDirectory } from "@/features/session/data/sync/session-source"
import { localWorkspaceInProjects, signedWorkspaceFromProjects } from "@/platform/runtime/agent/signed-workspace"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import type { LiveSession } from "../global-sdk-event-fetch"
import type { SessionRef } from "@/platform/identity/session-ref"

export const USER_HOSTED_WORKSPACE_KIND = "user-hosted"

export type GlobalSdkClientOptions = Omit<Parameters<typeof createSdkForServer>[0], "server" | "fetch"> & {
  workspaceId?: string
}
type WorkspaceProjects = Parameters<typeof signedWorkspaceFromProjects>[0]

export function nextLiveSession(
  current: LiveSession | undefined,
  sessionID: string,
  opts?: { host?: "central" | "workspace"; directory?: string; workspaceId?: string; workspaceKind?: string; sessionRef?: SessionRef },
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
    workspaceKind: opts?.workspaceKind ?? (sameScope ? current?.workspaceKind : undefined),
    sessionRef: opts?.sessionRef ?? (sameScope ? current?.sessionRef : undefined),
  }
}

export function liveSessionTransition(
  current: LiveSession | undefined,
  sessionID: string,
  opts?: { host?: "central" | "workspace"; directory?: string; workspaceId?: string; workspaceKind?: string; sessionRef?: SessionRef },
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

/**
 * The directory identity a live session's events are published under.
 *
 * A workspace id is the only identity of a relay-backed workspace both ends
 * agree on: the runtime stamps every frame with its OWN filesystem path, which
 * addresses nothing here, so the id — not the frame's `directory` — is what an
 * event is routed by. The consumers, though, are keyed by the ADDRESS the pane
 * resolved for that workspace, and that address is `sessionRowDirectory`'s
 * `workspace:<id>`: the same form the workspace catalog gives the row
 * (`workspaceRowDirectory`), the route resolves for the pane
 * (`resolveWorkspaceRouteDirectory`), and every session row of that workspace
 * carries.
 *
 * Publishing under the BARE id addressed the projected `message.part.updated`
 * / `message.part.delta` of an attached session to a scope no pane had
 * registered — `conversationScopeKey` is an exact `directory\0sessionID` match
 * — so every delta was dropped and the turn appeared only at the settlement
 * catch-up refetch, as one finished block. Routing through the one owner of
 * that address makes producer and consumer name a single scope, which the
 * pane's session query keys share too.
 */
export function eventDirectoryForLiveSession(input: {
  directory: string
  liveSession?: LiveSession
}): string {
  if (input.directory === "global") return input.directory
  const legacyDirectory = input.liveSession?.directory
  const workspaceId = input.liveSession?.workspaceId
    ?? (legacyDirectory ? sessionWorkspaceRuntimeRef({ directory: legacyDirectory })?.workspaceId : undefined)
  return sessionRowDirectory({ workspaceId, hostDirectory: input.directory })
}

/**
 * The workspace a client must be RELAY-ROUTED to, or `undefined` for "talk to
 * the server directly with `?directory=`".
 *
 * Every claxedo workspace carries a uuid, LOCAL ones included, so an explicit
 * `workspaceId` from a session row is not by itself evidence of a relay. The
 * inventory is the authority: a signed (cloud / user-hosted) workspace routes
 * through the relay, a known-local one never does, and an id the inventory
 * cannot place yet keeps the optimistic fallback — that is what lets a cloud
 * workspace work before its projects have loaded.
 *
 * Without the known-local rule, a local workspace's own rows were routed at the
 * relay and every request answered `401 Workspace connection failed`, which the
 * SDK reports as `data: undefined`. Callers that read absence as an assertion
 * (the rail's status batch: absent from `/session/status` means idle) then read
 * a request that never reached the runtime as "this session is idle".
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
 * The session and workspace identity the runtime-events stream opens for.
 *
 * Runtime events are scoped to one real parent session. `scopeSessionId` is
 * `session-event-scope`'s answer — the shell route's session, or the one the
 * composer published for a draft route — and it is authoritative: navigating to
 * another session must retarget the stream even though the live session still
 * names the one whose history was fetched last. `current` supplies the workspace
 * identity the stream is routed with (relay vs central), and its own session id
 * is used only when the scope has none.
 *
 * The workspace-route sentinel `"route"` used by the global lifecycle stream is
 * not an authorized parent and must never be sent as `parentSessionId` to a
 * Workspace Runtime, so it never survives as the session id here.
 */
export function runtimeEventLiveSession(
  current: LiveSession | undefined,
  projects: WorkspaceProjects,
  scopeSessionId?: string,
) {
  if (!current) return
  const sessionID = scopeSessionId?.trim()
    || (current.sessionID === "route" ? undefined : current.sessionID)
  if (!sessionID) return
  return liveSessionWithRelayBacking({ ...current, sessionID }, projects)
}
