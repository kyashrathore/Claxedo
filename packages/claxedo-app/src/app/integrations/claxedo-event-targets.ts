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

import { openLocalEventWebSocket } from "@/platform/sync/local-event-websocket"
import { sessionRowDirectory } from "@/platform/identity/workspace-address"
import { signedWorkspaceFromProjects } from "@/platform/runtime/agent/signed-workspace"
import { sameWorkspaceDirectory } from "@/platform/identity/legacy-resolver"
import { authFetch, getClaxedoServerUrl, hasApiCredentials } from "@/platform/api/api"
import {
  accountStreamAvailable,
  openAccountStreamResponse,
} from "@/platform/account/account-stream-fetch"
import type { AccountState } from "@/platform/account/account-port"
import { parseShellRoute, shellRouteDirectoryFromPathname } from "@/platform/identity/route"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { centralTransportForServer, createTransport } from "@/platform/runtime/transport"
import { isRelayBackedWorkspaceKind, workspaceKind } from "@/platform/runtime/agent/workspace-kind"
import { controlPlaneEventsUrl } from "@/platform/runtime/agent/workspace-control-routes"

type ProjectCache = Parameters<typeof signedWorkspaceFromProjects>[0]

/**
 * The two streams a client reads. `cp` is the control plane's notice stream,
 * fetched directly under control-plane auth. `wr` is one workspace runtime's
 * stream: a runtime-owned long-lived GET behind the workspace's relay
 * connection, reached with the Runtime Access Token exactly like provider,
 * file and PTY reads — or, for a local workspace, through the daemon's
 * loopback proxy to its embedded runtime.
 *
 * A `wr` target opens the stream unscoped: the workspace's owner sees every
 * session and every session-less frame. `sessionID` is the fallback for a
 * reader the runtime refuses at workspace level — a share grantee, who holds
 * a grant on one session and no workspace access — and is used only after
 * that refusal.
 */
export type ClaxedoEventStreamTarget =
  | { kind: "cp"; url: URL }
  | {
      kind: "wr"
      serverUrl: string
      workspaceId: string
      workspaceKind?: "local" | "cloud" | "user-hosted"
      directory?: string
      sessionID?: string
    }

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
  /** The routed session, kept as the fallback scope for a reader refused at workspace level. */
  sessionID?: string
  /** Whether the account is signed in; only the signed-web deployment needs it. */
  accountSigned?: boolean
}): ClaxedoEventStreamTarget[] {
  const serverUrl = input.serverUrl ?? getClaxedoServerUrl()
  const cp: ClaxedoEventStreamTarget = {
    kind: "cp",
    url: controlPlaneEventsUrl({ baseUrl: serverUrl }),
  }
  const routeWorkspace = input.directory ? sessionWorkspaceRuntimeRef({ directory: input.directory }) : undefined
  const workspace = routeWorkspace
    ?? signedWorkspaceFromProjects(input.projects ?? [], input.directory)
      // Local workspaces have no relay identity. Resolve them separately so
      // signed desktop can still read their events alongside the account feed.
      ?? localWorkspaceForDirectory(input.projects ?? [], input.directory)

  // Which deployment this is decides whether the control-plane stream exists
  // at all — the same fact the boot reads. On LOOPBACK it is the local daemon's
  // own and is always read. On signed-web it is the hosted control plane's, a
  // route only a signed document can reach; an unsigned page that opens it
  // holds a permanently 404ing retry loop, so account state gates it there.
  const base = centralTransportForServer(serverUrl) === "loopback" || input.accountSigned === true
    ? [cp]
    : []
  if (!workspace) return base
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
  options?: { request?: typeof fetch; relayRequest?: typeof fetch; accountState?: AccountState; scope?: "workspace" | "session" },
) {
  if (target.kind === "cp") {
    // Signed accounts stream the hosted control plane through the account
    // bridge; every other account state (unsigned, unconfigured build,
    // pending, revoked) keeps `authFetch` against the local daemon's own
    // route — see `accountStreamAvailable` for why bridge presence alone
    // must not route here.
    if (
      !options?.request &&
      accountStreamAvailable(options?.accountState ?? { status: "unsigned" })
    ) {
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
  const serverTransport = centralTransportForServer(target.serverUrl)
  const request = options?.request ?? authFetch
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
 * rule `sessionRowDirectory` applies to a row.
 */
export function eventStreamFrameAddress(target: ClaxedoEventStreamTarget): StreamFrameAddress {
  const relayBacked = target.kind === "wr" && isRelayBackedWorkspaceKind(workspaceKind(target.workspaceKind))
  if (!relayBacked) return (hostDirectory) => hostDirectory
  return (hostDirectory) => sessionRowDirectory({ workspaceId: target.workspaceId, hostDirectory })
}

export function routeDirectory(pathname: string) {
  if (typeof window === "undefined") return undefined
  const routed = shellRouteDirectoryFromPathname(pathname)
  if (routed) return routed
  const configured = (window as typeof window & {
    __OPENCODE__?: { activeDirectory?: string }
  }).__OPENCODE__?.activeDirectory
  if (configured) return configured
  return undefined
}

export function eventStreamTargetKey(
  target: ClaxedoEventStreamTarget,
  options: { accountSigned?: boolean } = {},
) {
  if (target.kind === "cp") {
    return `cp:${target.url.href}:${options.accountSigned === true ? "signed" : "unsigned"}`
  }
  return `wr:${target.serverUrl}:${target.workspaceId}:${target.directory ?? ""}:${target.sessionID ?? ""}`
}
