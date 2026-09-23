/**
 * Explicit, testable session-routing placement table.
 *
 * agent-runtime-client.ts is the single place that decides, per request,
 * whether a session read/write goes to the client-presentation transport,
 * the loopback runtime transport, the signed central control plane, or the
 * relay-backed workspace runtime. Each branch here is named for the scenario
 * it handles and is unit-tested in isolation (see placement-table.test.ts),
 * as a pure decision point rather than inline branching in the client. The
 * client keeps ownership of the async workspace resolution (I/O) and the
 * actual fetch; only the routing decision is pure and lives here.
 */
import type { SessionRef } from "@/platform/identity/session-ref"
import type { Placement } from "@/platform/runtime/placement"
import { usesScopedSessionTransport, workspaceIdFromRef } from "@/platform/identity/legacy-resolver"
import { centralTransportForServer, isLocalPersonalScope } from "@/platform/runtime/transport"
import { type WorkspaceHostKind } from "@/platform/runtime/placement-wire"

export { workspaceIdFromRef }

/**
 * Server context for placement decisions.
 * - `serverUrl` is the raw trimmed value (or undefined for the default plane).
 * - `baseUrl` is the resolved absolute base URL.
 */
export type PlacementServerContext = {
  serverUrl?: string
  baseUrl: string
}

/** A session directory scope: a workspace ref (`ws_`/`workspace:`) or a filesystem path. */
export type RuntimeDirectory = string

/**
 * Should this session op use the runtime session transport instead of the
 * injected legacy OpenCode SDK client?
 *
 * True for signed (control-plane) sessions, central-hosted refs, workspace
 * tool-sandbox refs, and any directory whose shape marks it as scoped
 * (a `ws_`/`workspace:` ref or a filesystem path). Otherwise the legacy client
 * owns the op (plain `opencode`/`ses_*` sessions).
 */
export function shouldUseRuntimeSessionTransport(input: {
  sessionID?: string
  directory: RuntimeDirectory
  signed: boolean
  sessionRef?: SessionRef
}): boolean {
  if (input.signed) return true
  if (input.sessionRef?.toolSandbox?.kind === "workspace") return true
  return usesScopedSessionTransport(input.sessionID, input.directory)
}

/**
 * Resolve the transport placement (hosting + transport) for a runtime request.
 * Pure given the server context; the caller supplies the resolved sessionRef /
 * workspaceId.
 */
export function resolveRuntimePlacement(
  input: {
    directory?: string
    sessionRef?: SessionRef
    workspaceId?: string
    preferRelayOnLoopback?: boolean
  },
  ctx: PlacementServerContext,
): Placement {
  const loopback = centralTransportForServer(ctx.baseUrl) === "loopback"
  const workspaceTransport = input.preferRelayOnLoopback || !loopback ? "workspace-relay" : "loopback"

  // An explicit workspace tool-sandbox: route to that workspace's runtime.
  if (input.sessionRef?.toolSandbox?.kind === "workspace") {
    return {
      workspaceId: input.sessionRef.toolSandbox.workspaceId,
      ...(input.sessionRef.toolSandbox.hostId ? { hostId: input.sessionRef.toolSandbox.hostId } : {}),
      hosting: "workspace",
      transport: workspaceTransport,
    }
  }
  // A local tool-sandbox stays on the loopback runtime.
  if (input.sessionRef?.toolSandbox?.kind === "local") {
    return { hosting: "workspace", transport: "loopback" }
  }
  // A bare workspace id (no ref) routes to that workspace's runtime.
  if (input.workspaceId) {
    return {
      workspaceId: input.workspaceId,
      hosting: "workspace",
      transport: workspaceTransport,
    }
  }
  // Local Personal Mode (loopback server + filesystem directory) → loopback.
  if (isLocalPersonalScope({ serverUrl: ctx.serverUrl, directory: input.directory })) {
    return { hosting: "workspace", transport: "loopback" }
  }
  throw new Error("A machine workspace is required for session execution")
}

/**
 * The `fetchSessionResource` routing decision as a single typed value.
 *
 * - `runtime-session-ref`: unsigned op with a resolved sessionRef — ride the
 *   runtime transport bound to that ref.
 * - `runtime-workspace`: divert to a specific workspace's runtime (relay or
 *   loopback); `preferRelayOnLoopback` forces the relay even on a loopback
 *   server (machine-placed / unresolved-host legacy refs).
 * - `control-plane`: signed request to the central control plane.
 * - `direct`: unsigned direct request to the runtime session URL.
 */
export type SessionResourceRoute =
  | { via: "runtime-session-ref" }
  | { via: "runtime-workspace"; workspaceId: string; preferRelayOnLoopback?: boolean }
  | { via: "control-plane" }
  | { via: "direct" }

export function resolveSessionResourceRoute(input: {
  signed: boolean
  hasSessionRef: boolean
  targetWorkspaceId?: string
  targetKind?: WorkspaceHostKind
  directoryWorkspaceId?: string
  resource?: string
  loopback: boolean
  /**
   * Is the target workspace's runtime able to answer right now? Only consulted
   * for the loopback message divert (B). `undefined` means unknown, which keeps
   * the pre-existing divert.
   */
  targetReachable?: boolean
}): SessionResourceRoute {
  const { signed, hasSessionRef, targetWorkspaceId, targetKind, directoryWorkspaceId, resource, loopback } = input

  // A: an unsigned op with a resolved ref always rides that ref's runtime
  //    transport (central/workspace/local decided by resolveRuntimePlacement).
  if (!signed && hasSessionRef) return { via: "runtime-session-ref" }

  // B: signed loopback message reads divert to the workspace runtime so the
  //    local relay serves durable history (the control store is empty on
  //    loopback).
  //    NOT when that runtime is known-unreachable AND the workspace is
  //    confirmed cloud: a cloud session's history is synced to the control
  //    plane, so a dead sandbox must not take the transcript with it. Diverting
  //    there would hang on a runtime that cannot answer. Machine-placed and
  //    unresolved-kind workspaces keep the divert — for those the runtime is
  //    the only store, so an unreachable one means there is genuinely nothing
  //    to read and the relay's own failure is the honest answer.
  if (signed && targetWorkspaceId && resource === "messages" && loopback) {
    const centralHistory = targetKind === "provisioner" && input.targetReachable === false
    if (!centralHistory) return { via: "runtime-workspace", workspaceId: targetWorkspaceId }
  }

  // C: signed machine-placed — or an unresolved-host legacy `ws_` directory ref,
  //    which is indistinguishable from cloud by shape — diverts to the relay
  //    runtime. The central control plane has no session store for those,
  //    so asserting cloud here would 404. `preferRelayOnLoopback` forces the
  //    relay even when the server itself is loopback.
  if (signed && targetWorkspaceId && (targetKind === "machine" || (!targetKind && !!directoryWorkspaceId))) {
    return { via: "runtime-workspace", workspaceId: targetWorkspaceId, preferRelayOnLoopback: true }
  }

  // D: an unsigned relay-backed directory ref rides that workspace's runtime.
  if (!signed && directoryWorkspaceId) {
    return { via: "runtime-workspace", workspaceId: directoryWorkspaceId }
  }

  // E: signed → central control plane; unsigned → direct request to the runtime URL.
  return signed ? { via: "control-plane" } : { via: "direct" }
}
