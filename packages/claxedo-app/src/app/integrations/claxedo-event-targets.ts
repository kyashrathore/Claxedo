/**
 * Which event streams the app must have open, and how each one is opened.
 *
 * `ClaxedoEventsProvider` (./claxedo-events.tsx) is the runtime that keeps the
 * connections; this module is the pure decision it drives — the discriminated
 * target list for a route + scope + project catalog, the stable key that makes
 * a retarget a teardown-and-reopen, and the fetch seam that resolves a target
 * to a `Response` (relay for a signed workspace, loopback proxy for a local
 * one, account bridge for the central control-plane stream).
 */

import { sameWorkspaceDirectory, signedWorkspaceFromProjects } from "@/platform/runtime/agent/signed-workspace"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import {
  accountStreamAvailable,
  openAccountStreamResponse,
} from "@/platform/account/account-stream-fetch"
import type { AccountState } from "@/platform/account/account-port"
import { parseShellRoute, shellRouteDirectoryFromPathname } from "@/platform/identity/route"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { centralTransportForServer, createTransport } from "@/platform/runtime/transport"
import { controlPlaneEventsUrl } from "@/platform/runtime/agent/workspace-control-routes"

type ProjectCache = Parameters<typeof signedWorkspaceFromProjects>[0]

// The central GLOBAL event stream is fetched directly (signed control-plane
// auth). The per-workspace stream is a runtime-owned long-lived GET that lives
// behind the workspace's relay connection and is reached with the Runtime
// Access Token — exactly like provider/file/PTY reads. Targets are therefore
// discriminated so the events provider can pick the right transport: the
// central stream uses `authFetch`, the workspace stream uses the transport
// seam so loopback workspace streams stay on the local proxy while remote
// workspace streams open through the relay.
export type ClaxedoEventStreamTarget =
  | { kind: "central"; url: URL }
  | {
      kind: "workspace"
      serverUrl: string
      workspaceId: string
      workspaceKind?: "local" | "cloud" | "user-hosted"
      directory?: string
      /** Canonical managed-private session admitted by the runtime policy. */
      sessionID?: string
    }

/**
 * The workspace id for a LOCAL workspace at `directory`.
 *
 * `signedWorkspaceFromProjects` deliberately skips anything that is not
 * `cloud` / `user-hosted`, because signed identity is what the relay needs.
 * Event streams need an id for a different reason — to name which workspace's
 * events to receive — and a local workspace has one in the projects cache.
 */
function localWorkspaceForDirectory(projects: ProjectCache, directoryOrId: string | undefined) {
  if (!directoryOrId) return undefined
  for (const project of projects) {
    for (const [key, workspace] of Object.entries(project.workspaces ?? {})) {
      if (workspace.kind && workspace.kind !== "local") continue
      const workspaceId = workspace.workspaceId ?? workspace.id ?? key
      if (!workspaceId) continue
      // The shell route is `/w/<workspaceId>/…`, so what reaches here is often
      // the workspace ID rather than a path — matching on directory alone
      // silently found nothing and left the workspace stream unopened.
      if (
        workspaceId === directoryOrId ||
        key === directoryOrId ||
        sameWorkspaceDirectory(workspace.directory, directoryOrId)
      ) return {
        workspaceId,
        kind: "local" as const,
        directory: workspace.directory ?? directoryOrId,
      }
    }
  }
  return undefined
}

export function claxedoEventStreamTargets(input: {
  serverUrl?: string
  directory?: string
  projects?: ProjectCache
  sessionID?: string
  /** Whether the account is signed in; only the signed-web deployment needs it. */
  accountSigned?: boolean
}): ClaxedoEventStreamTarget[] {
  const serverUrl = input.serverUrl ?? getClaxedoServerUrl()
  const central: ClaxedoEventStreamTarget = {
    kind: "central",
    url: controlPlaneEventsUrl({ baseUrl: serverUrl }),
  }
  const routeWorkspace = input.directory ? sessionWorkspaceRuntimeRef({ directory: input.directory }) : undefined
  const workspace = routeWorkspace
    ?? signedWorkspaceFromProjects(input.projects ?? [], input.directory)
      // A local workspace has no signed identity, so both lookups above are
      // empty; it still needs the per-workspace stream, which is where every
      // workspace-scoped event (`pty.*`, `agent.lifecycle`, session status) is
      // published — the bare central stream carries only `server.connected`
      // and heartbeats.
      ?? localWorkspaceForDirectory(input.projects ?? [], input.directory)

  // Which deployment this is decides whether the central stream exists at all —
  // the same fact the boot reads. On LOOPBACK the "central" stream is the local
  // daemon's own global event stream: it carries this surface's whole event
  // feed and the surface has no account by contract, so it is always read. On
  // signed-web it is the hosted control plane's `/api/claxedo/events`, a route
  // only a signed document can reach; an unsigned page that opens it holds a
  // permanently 404ing retry loop, so account state gates it there and only
  // there.
  const base = centralTransportForServer(serverUrl) === "loopback" || input.accountSigned === true
    ? [central]
    : []
  if (!workspace) return base
  const sessionID = input.sessionID?.trim()
  // A managed-private runtime serves SESSION-scoped streams only:
  // `authorizeSessionEventScope` (workspace-runtime routes/session-event-privacy.ts:50-60)
  // answers an unscoped request with a permanent 400 `session_event_scope_required`.
  // Which session that is comes from `session-event-scope.ts`, not from the
  // route alone — see its module comment for why the composer has to be able to
  // publish a just-created session before the route navigates to it.
  // Local keeps the broad workspace stream (`pty.created`, `agent.lifecycle`,
  // `worktree.ready`) — so the CATALOG, not a caller's inventory, must say "local".
  if (workspace.kind !== "local" && (!sessionID || sessionID === "new")) return base
  return [
    ...base,
    {
      kind: "workspace",
      serverUrl,
      workspaceId: workspace.workspaceId,
      workspaceKind: workspace.kind,
      ...(workspace.kind !== "local" && sessionID ? { sessionID } : {}),
      ...("directory" in workspace && workspace.directory
        ? { directory: workspace.directory }
        : input.directory
          ? { directory: input.directory }
          : {}),
    },
  ]
}

// Resolves the fetch + request URL for a target. The workspace stream streams
// from the relay (`relayUrl/workspaces/:id/api/wr/events`) with the RAT in
// `Authorization: Bearer`; the central stream is fetched directly. Both return a
// `Response` whose body the provider reads incrementally (the relay seam does
// NOT buffer GET responses).
export const CLAXEDO_EVENTS_RELAY_PATH = "/api/wr/events"

/** Returns only a real session identity owned by the canonical shell route. */
export function claxedoEventRouteSessionID(pathname: string) {
  const route = parseShellRoute(pathname)
  if (!("sessionId" in route)) return
  const sessionID = route.sessionId?.trim()
  if (!sessionID || sessionID === "new") return
  return sessionID
}

export async function eventStreamFetch(
  target: ClaxedoEventStreamTarget,
  init: RequestInit,
  options?: { request?: typeof fetch; relayRequest?: typeof fetch; accountState?: AccountState },
) {
  if (target.kind === "central") {
    // Signed accounts stream the hosted central bus through the account
    // bridge; every other account state (unsigned, unconfigured build,
    // pending, revoked) keeps `authFetch` against the local server's own
    // `/api/claxedo/events` — see `accountStreamAvailable` for why bridge
    // presence alone must not route here.
    if (
      !options?.request &&
      accountStreamAvailable(options?.accountState ?? { status: "unsigned" })
    ) {
      const lastEventId = new Headers(init.headers).get("Last-Event-ID") ?? undefined
      return openAccountStreamResponse({
        operation: "session.events",
        params: lastEventId ? { lastEventId } : {},
        signal: init.signal ?? undefined,
      })
    }
    return (options?.request ?? authFetch)(target.url, init)
  }
  const serverTransport = centralTransportForServer(target.serverUrl)
  const request = options?.request ?? authFetch
  const runtimeUrl = new URL(CLAXEDO_EVENTS_RELAY_PATH, "http://workspace-runtime.local")
  if (target.workspaceKind === "local" && target.directory) {
    runtimeUrl.searchParams.set("directory", target.directory)
  } else if (target.sessionID) {
    runtimeUrl.searchParams.set("sessionID", target.sessionID)
  }
  const runtimePath = `${runtimeUrl.pathname}${runtimeUrl.search}`
  return createTransport({
    placement: {
      workspaceId: target.workspaceId,
      hosting: "workspace",
      transport: serverTransport === "loopback" ? "loopback" : "workspace-relay",
    },
    serverUrl: target.serverUrl,
    directory: target.directory,
    ...(target.workspaceKind ? { workspace: { kind: target.workspaceKind, workspaceId: target.workspaceId } } : {}),
    request,
    ...(options?.relayRequest ? { relayRequest: options.relayRequest } : {}),
  }).fetch(runtimePath, init)
}

export function routeDirectory(pathname: string) {
  if (typeof window === "undefined") return
  const routed = shellRouteDirectoryFromPathname(pathname)
  if (routed) return routed
  const configured = (window as typeof window & {
    __OPENCODE__?: { activeDirectory?: string }
  }).__OPENCODE__?.activeDirectory
  if (configured) return configured
}

export function eventStreamTargetKey(
  target: ClaxedoEventStreamTarget,
  options: { accountSigned?: boolean } = {},
) {
  if (target.kind === "central") {
    return `central:${target.url.href}:${options.accountSigned === true ? "signed" : "unsigned"}`
  }
  return `workspace:${target.serverUrl}:${target.workspaceId}:${target.directory ?? ""}:${target.sessionID ?? ""}`
}
