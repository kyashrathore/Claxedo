/**
 * Which event streams the app must have open, and how each one is opened.
 *
 * `ClaxedoEventsProvider` (./claxedo-events.tsx) is the runtime that keeps the
 * connections; this module is the pure decision it drives — the discriminated
 * target list for a route + scope + project catalog, the stable key that makes
 * a retarget a teardown-and-reopen, and the fetch seam that resolves a target
 * to a `Response` (relay for a signed workspace, loopback proxy for a local
 * one, the server's own `cp/events` for the daemon's control plane, the
 * account bridge for the hosted one).
 */

import { openLocalEventWebSocket } from "@/platform/sync/local-event-websocket"
import { sessionRowDirectory } from "@/platform/identity/workspace-address"
import { signedWorkspaceFromProjects } from "@/platform/runtime/agent/signed-workspace"
import { isFilesystemDirectory, sameWorkspaceDirectory } from "@/platform/identity/legacy-resolver"
import { authFetch, getClaxedoServerUrl, hasApiCredentials } from "@/platform/api/api"
import {
  openAccountStreamResponse,
} from "@/platform/account/account-stream-fetch"
import { parseShellRoute, shellRouteDirectoryFromPathname } from "@/platform/identity/route"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { centralTransportForServer, createTransport } from "@/platform/runtime/transport"
import { isRelayBackedWorkspaceKind, workspaceKind } from "@/platform/runtime/agent/workspace-kind"
import { controlPlaneEventsUrl } from "@/platform/runtime/agent/workspace-control-routes"

type ProjectCache = Parameters<typeof signedWorkspaceFromProjects>[0]

/**
 * The two streams a client reads. `cp` is a control plane's notice stream:
 * the server's own (`transport: "server"` — the daemon's over loopback, the
 * hosted one over control-plane auth on signed web), and, on a signed
 * desktop, ALSO the hosted control plane's through the Electron account
 * bridge (`transport: "account"`) — a signed desktop has two control planes,
 * and the daemon's is the only one that rings for its local workspaces. `wr`
 * is one workspace runtime's stream: a runtime-owned long-lived GET behind
 * the workspace's relay connection, reached with the Runtime Access Token
 * exactly like provider, file and PTY reads — or, on a loopback surface (the
 * desktop, a local page), through the daemon's proxy: to its embedded
 * runtime for a local workspace, and for a cloud or user-hosted workspace
 * through `localWorkspaceRelayProxy` (`/workspaces/<id>/api/wr/events`),
 * where the daemon mints the owner's runtime token itself, per request, and
 * forwards the cursor. The desktop's cloud wire is that proxy, not the
 * browser relay; its stream ends at each token's expiry (ten minutes) and
 * the reconnect resumes by cursor, the runtime keying its ring by the actor.
 *
 * A workspace-scoped `wr` target opens the stream unscoped: a principal the
 * workspace admits reads every session-less frame and every session the
 * session authority grants it (creator, participant, share grantee, org
 * admin). The workspace's owner role is not one of those: a session another
 * member created reaches it only through a grant. `sessionID` is the
 * fallback for a reader the runtime refuses at workspace level — a share
 * grantee, who holds a grant on one session and no workspace access — and is
 * used only after that refusal.
 *
 * The `scope: "host"` target is the daemon's HOST AGGREGATE: `wr/events` with
 * no workspace named, carrying every embedded runtime's frames on one
 * connection. It is what makes a local workspace that is not on screen stay
 * live without a connection per workspace. Whether it exists is the SERVER's
 * declaration (`events.hostAggregate` in its bootstrap body), never a guess
 * from the URL or from the build: a self-hosted node that issues sessions runs
 * its issuer on loopback too, and the aggregate refuses a relay-stamped reader
 * unconditionally there, so a page that opened it on a URL match would hold a
 * permanently retrying 403 while its local workspaces went silent. The
 * aggregate's frames carry each runtime's own directory, which on this machine
 * is the address every consumer is keyed by.
 */
export type HostAggregateEventStreamTarget = { kind: "wr"; scope: "host"; serverUrl: string }

export type WorkspaceEventStreamTarget = {
  kind: "wr"
  scope?: undefined
  serverUrl: string
  workspaceId: string
  workspaceKind?: "local" | "cloud" | "user-hosted"
  directory?: string
  sessionID?: string
}

export type ClaxedoEventStreamTarget =
  | { kind: "cp"; url: URL; transport: "server" | "account" }
  | HostAggregateEventStreamTarget
  | WorkspaceEventStreamTarget

function* localWorkspacesInProjects(projects: ProjectCache) {
  for (const project of projects) {
    for (const [key, workspace] of Object.entries(project.workspaces ?? {})) {
      if (workspace.kind && workspace.kind !== "local") continue
      const workspaceId = workspace.workspaceId ?? workspace.id ?? key
      if (!workspaceId) continue
      yield { workspaceId, key, directory: workspace.directory ?? undefined }
    }
  }
}

function localWorkspaceForDirectory(projects: ProjectCache, directoryOrId: string | undefined) {
  if (!directoryOrId) return undefined
  for (const { workspaceId, key, directory } of localWorkspacesInProjects(projects)) {
    // The shell route is `/w/<workspaceId>/…`, so what reaches here is often
    // the workspace id rather than a path.
    if (
      workspaceId === directoryOrId ||
      key === directoryOrId ||
      sameWorkspaceDirectory(directory, directoryOrId)
    ) return {
      workspaceId,
      kind: "local" as const,
      directory: directory ?? directoryOrId,
    }
  }
  return undefined
}

/** The workspace a route addresses, by its runtime ref, the signed catalog, or the local catalog. */
function routeWorkspaceRef(input: { directory?: string; projects?: ProjectCache }) {
  const routeWorkspace = input.directory
    ? sessionWorkspaceRuntimeRef({ directory: input.directory, ...(input.projects ? { projects: input.projects } : {}) })
    : undefined
  return routeWorkspace
    ?? signedWorkspaceFromProjects(input.projects ?? [], input.directory)
    // Local workspaces have no relay identity. Resolve them separately so
    // signed desktop can still read their events alongside the account feed.
    ?? localWorkspaceForDirectory(input.projects ?? [], input.directory)
}

type RouteStreamDecision =
  | { stream: "none" }
  | { stream: "pending" }
  | { stream: "aggregate" }
  | { stream: "scoped"; workspace: NonNullable<ReturnType<typeof routeWorkspaceRef>> }

/**
 * Which open stream carries the routed workspace's frames — the one answer
 * {@link claxedoEventStreamTargets} and {@link routeAwaitsWorkspaceStream}
 * both read, so a route can never both be handed no stream and be told it has
 * one.
 *
 * `pending` is the state where nothing carries them yet and the composer must
 * hold its first prompt: the server has not said whether it serves the
 * aggregate, or the catalog has not placed a workspace whose own stream would
 * be opened. `aggregate` needs no second connection — a local runtime's frames
 * delivered twice replay `session.idle`, which plays the completion sound on
 * each delivery.
 *
 * With the aggregate served, a plain filesystem path rides it whether or not
 * the catalog has placed it: the daemon serves the paths on its OWN machine,
 * so a path is local by construction, and only a catalog entry that positively
 * names one cloud or user-hosted belongs to a runtime elsewhere. A `ws_`-shaped
 * route id is the opposite — the catalog may simply not have loaded yet — so it
 * stays optimistically relay-backed and keeps its own stream.
 */
function routeStreamDecision(input: {
  directory?: string
  projects?: ProjectCache
  loopback: boolean
  hostAggregate: boolean | undefined
}): RouteStreamDecision {
  if (input.directory === undefined) return { stream: "none" }
  if (input.loopback && input.hostAggregate === undefined) return { stream: "pending" }
  const workspace = routeWorkspaceRef(input)
  if (input.loopback && input.hostAggregate === true) {
    const pathOnThisMachine =
      isFilesystemDirectory(input.directory) && !signedWorkspaceFromProjects(input.projects ?? [], input.directory)
    if (!workspace) return pathOnThisMachine ? { stream: "aggregate" } : { stream: "pending" }
    if (workspace.kind === "local" || pathOnThisMachine) return { stream: "aggregate" }
    return { stream: "scoped", workspace }
  }
  return workspace ? { stream: "scoped", workspace } : { stream: "pending" }
}

/**
 * The route names a workspace no target in {@link claxedoEventStreamTargets}
 * carries yet, so the composer holds its first prompt rather than let the
 * turn's frames arrive as a late burst through the stream-open resync.
 */
export function routeAwaitsWorkspaceStream(input: {
  serverUrl?: string
  directory?: string
  projects?: ProjectCache
  hostAggregate: boolean | undefined
}): boolean {
  const serverUrl = input.serverUrl ?? getClaxedoServerUrl()
  return routeStreamDecision({
    ...input,
    loopback: centralTransportForServer(serverUrl) === "loopback",
  }).stream === "pending"
}

export function claxedoEventStreamTargets(input: {
  serverUrl?: string
  directory?: string
  projects?: ProjectCache
  /** The routed session, kept as the fallback scope for a reader refused at workspace level. */
  sessionID?: string
  /**
   * The server's own declaration that it serves the host aggregate
   * (`events.hostAggregate` in its bootstrap body). `undefined` until that boot
   * lands, and that is a third answer, not a missing `false`: no `wr` stream is
   * opened on a guess, and the route waits instead.
   */
  hostAggregate: boolean | undefined
  /** Whether the account is signed in; only the signed-web deployment needs it. */
  accountSigned?: boolean
  /** A signed desktop with the Electron account bridge: the hosted control plane is reachable through it. */
  accountStream?: boolean
}): ClaxedoEventStreamTarget[] {
  const serverUrl = input.serverUrl ?? getClaxedoServerUrl()
  const cp: ClaxedoEventStreamTarget = {
    kind: "cp",
    url: controlPlaneEventsUrl({ baseUrl: serverUrl }),
    transport: "server",
  }
  // Which control-plane streams exist is the URL's answer: the daemon's own is
  // always read over loopback, and a signed desktop reads the hosted one too
  // through the account bridge. On signed-web the server's stream IS the hosted
  // control plane's, a route only a signed document can reach; an unsigned page
  // that opens it holds a permanently 404ing retry loop, so account state gates
  // it there. Whether the aggregate exists is not the URL's answer but the
  // server's, so it is asked separately.
  const loopback = centralTransportForServer(serverUrl) === "loopback"
  const base: ClaxedoEventStreamTarget[] = loopback
    ? [
        cp,
        ...(input.accountStream ? [{ ...cp, transport: "account" as const }] : []),
        ...(input.hostAggregate === true
          ? [{ kind: "wr", scope: "host", serverUrl } satisfies HostAggregateEventStreamTarget]
          : []),
      ]
    : input.accountSigned === true
      ? [cp]
      : []
  const decision = routeStreamDecision({ ...input, loopback })
  if (decision.stream !== "scoped") return base
  const workspace = decision.workspace
  const sessionID = input.sessionID?.trim()
  return [
    ...base,
    {
      kind: "wr",
      serverUrl,
      workspaceId: workspace.workspaceId,
      workspaceKind: workspace.kind,
      ...(sessionID && sessionID !== "new" ? { sessionID } : {}),
      ...("directory" in workspace && workspace.directory
        ? { directory: workspace.directory }
        : input.directory
          ? { directory: input.directory }
          : {}),
    },
  ]
}

export const WORKSPACE_EVENTS_PATH = "/api/wr/events"

/** Returns only a real session identity owned by the canonical shell route. */
export function claxedoEventRouteSessionID(pathname: string) {
  const route = parseShellRoute(pathname)
  if (!("sessionId" in route)) return undefined
  const sessionID = route.sessionId?.trim()
  if (!sessionID || sessionID === "new") return undefined
  return sessionID
}

export async function eventStreamFetch(
  target: ClaxedoEventStreamTarget,
  init: RequestInit,
  options?: { request?: typeof fetch; relayRequest?: typeof fetch; scope?: "workspace" | "session" },
) {
  if (target.kind === "cp") {
    if (target.transport === "account") {
      const lastEventId = new Headers(init.headers).get("Last-Event-ID") ?? undefined
      return openAccountStreamResponse({
        operation: "controlPlane.events",
        params: lastEventId ? { lastEventId } : {},
        signal: init.signal ?? undefined,
      })
    }
    if (
      !options?.request &&
      centralTransportForServer(target.url.origin) === "loopback" &&
      !new Headers(init.headers).has("Authorization") &&
      !await hasApiCredentials()
    ) {
      return openLocalEventWebSocket(target.url, init)
    }
    return (options?.request ?? authFetch)(target.url, init)
  }
  const request = options?.request ?? authFetch
  // The aggregate is the daemon's own route, named by no workspace: no
  // directory to scope it by and no relay to reach it through.
  if (target.scope === "host") return request(new URL(WORKSPACE_EVENTS_PATH, target.serverUrl), init)
  const serverTransport = centralTransportForServer(target.serverUrl)
  const runtimeUrl = new URL(WORKSPACE_EVENTS_PATH, "http://workspace-runtime.local")
  if (target.directory) runtimeUrl.searchParams.set("directory", target.directory)
  if (options?.scope === "session" && target.sessionID) runtimeUrl.searchParams.set("sessionID", target.sessionID)
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

/**
 * Translates the path a producer stamped on a frame — its OWN machine's — into
 * the address this app registered that workspace under. Named as the two
 * different things it maps between, because "directory" alone is exactly the
 * ambiguity that let a host path stand where a workspace address belongs.
 */
export type StreamFrameAddress = (hostDirectory: string) => string

/**
 * The address a frame received on `target`'s stream is published under.
 *
 * A workspace runtime stamps every frame it publishes with its OWN filesystem
 * path, because that is the only path it has. On a relay-backed workspace that
 * machine is not this one, so the path addresses nothing here — while the pane,
 * the rail section and every session row of that workspace are registered under
 * `workspace:<id>` (`sessionRowDirectory`, the one owner of that form). The
 * translation belongs here, at the stream boundary, because a workspace stream
 * is opened for exactly one workspace and this target names it; deriving it
 * from the frame's path instead would have to guess which machine wrote it.
 *
 * A LOCAL workspace's stream is served by this surface's own runtime over
 * loopback, so its path IS this machine's and is returned unchanged — the same
 * rule `sessionRowDirectory` applies to a row. The host aggregate carries only
 * such runtimes, and one frame's workspace is not another's, so its frames are
 * addressed by the path each one carries.
 */
export function eventStreamFrameAddress(target: ClaxedoEventStreamTarget): StreamFrameAddress {
  const identity: StreamFrameAddress = (hostDirectory) => hostDirectory
  if (target.kind !== "wr" || target.scope === "host") return identity
  if (!isRelayBackedWorkspaceKind(workspaceKind(target.workspaceKind))) return identity
  const { workspaceId } = target
  return (hostDirectory) => sessionRowDirectory({ workspaceId, hostDirectory })
}

export function routeDirectory(pathname: string) {
  if (typeof window === "undefined") return undefined
  return shellRouteDirectoryFromPathname(pathname)
}

export function eventStreamTargetKey(target: ClaxedoEventStreamTarget) {
  if (target.kind === "cp") {
    return `cp:${target.url.href}:${target.transport}`
  }
  // The aggregate names no workspace, so its server is its whole identity —
  // and a daemon at another address hosts another set of runtimes, so the
  // open stream has to be torn down rather than pointed at it.
  if (target.scope === "host") return `wr:host:${target.serverUrl}`
  // The routed session is the stream's fallback scope, not its identity, and
  // the directory a route names is one of several spellings of the same
  // workspace (`/w/<id>`, `/s/<id>` through its inventory row, a host path):
  // a stream is the workspace's, so a navigation between them keeps it.
  return `wr:${target.serverUrl}:${target.workspaceId}`
}
