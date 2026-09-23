import { getClaxedoServerUrl } from "@/platform/api/api"
import { readProjectCatalog } from "@/platform/query/control-plane"
import { resolveWorkspaceRef } from "@/platform/identity/resolve-workspace-ref"
import type { SessionRef } from "@/platform/identity/session-ref"
import { isWorkspaceIdRef, localWorkspaceAssociationId, workspaceIdFromRef } from "@/platform/identity/legacy-resolver"
import { localWorkspaceInProjects, signedWorkspaceFromProjects } from "@/platform/runtime/agent/signed-workspace"
import type { RelayHostKind, WorkspaceHost, WorkspaceHostKind } from "@/platform/runtime/placement-wire"

// The signed project inventory (carries the real host kind for every
// relay-backed workspace). Shape matches `signedWorkspaceFromProjects`'s first
// arg.
type WorkspaceInventory = Parameters<typeof signedWorkspaceFromProjects>[0]

export type SessionWorkspaceRuntimeInput = {
  directory: string
  sessionRef?: SessionRef
  /** Explicit workspace identity carried by the pane's workspace route. */
  workspaceId?: string
  /**
   * The inventory to classify against. OMITTED means "the catalog this app has
   * already resolved" — not "no inventory".
   *
   * The answer depends on what the workspace IS, not on whether a caller
   * threaded the catalog down: a local `ws_*` route classifies as local from
   * any call site. Pass a value only to
   * classify against a DIFFERENT inventory (a test's, or a caller holding a
   * fresher list); an explicit `[]` still means "nothing known".
   */
  projects?: WorkspaceInventory
}

/**
 * The catalog's answer, with the placement it states.
 *
 * `host` rides along only when the matched row came from a control-plane list;
 * every caller that decides a wire needs to tell "this machine holds it" from
 * "this row's producer states no host at all".
 */
function signedRuntimeRef(signed: { workspaceId: string; kind: RelayHostKind; host?: WorkspaceHost }) {
  return { workspaceId: signed.workspaceId, kind: signed.kind, ...(signed.host ? { host: signed.host } : {}) }
}

function optimisticRelayRef(workspaceId: string, kind: RelayHostKind = "machine") {
  // ws_ ids can exist before signed inventory loads. Bare project UUIDs cannot:
  // they are the desktop local route id, and minting them 403s at the control plane.
  if (isWorkspaceIdRef(workspaceId) || workspaceIdFromRef(workspaceId)) {
    return { workspaceId, kind }
  }
  return undefined
}

export function sessionWorkspaceRuntimeRef(input: SessionWorkspaceRuntimeInput) {
  const projects = input.projects ?? readProjectCatalog(getClaxedoServerUrl())
  if (input.sessionRef) {
    const backing = resolveWorkspaceRef(input.sessionRef)
    if (backing.kind === "provisioner" || backing.kind === "machine") {
      // The inventory's answer wins when it has one: it carries the real host
      // kind, which the ref alone cannot.
      const signed = signedWorkspaceFromProjects(projects, backing.workspaceId)
        ?? signedWorkspaceFromProjects(projects, input.directory)
      if (signed) return signedRuntimeRef(signed)
      // Route activation can briefly carry a stale/legacy workspace-backed ref.
      // A loaded project catalog that positively identifies either the backing
      // id or its directory as local is the canonical owner and must win before
      // any connection lease is acquired.
      if (
        localWorkspaceInProjects(projects, backing.workspaceId) ||
        localWorkspaceInProjects(projects, input.directory)
      ) {
        return undefined
      }
      return optimisticRelayRef(backing.workspaceId, backing.kind)
    }
    // A central/virtual ref (`none` backing) stays unbacked — its workspaceId
    // is an authz-only scope, never a runtime target. But a `local` backing
    // does NOT prove the pane is local: session rows carry the runtime's
    // filesystem cwd (remote_directory), so refs built from them resolve
    // `local` even for relay-backed workspaces. Fall through to the
    // directory/inventory resolution below instead of concluding local here.
    if (backing.kind !== "self") return undefined
  }
  // Draft panes begin with a local SessionRef because no runtime session exists
  // yet. Once the user opens/selects a workspace route, that route is the
  // authoritative runtime target even though the draft's provider directory is
  // still the local project checkout. Resolve its real kind from inventory so
  // the pane SDK, model catalog, composer and WorkspaceGate share one relay.
  if (input.workspaceId) {
    const workspace = signedWorkspaceFromProjects(projects, input.workspaceId)
    if (workspace) return signedRuntimeRef(workspace)
    if (
      localWorkspaceInProjects(projects, input.workspaceId) ||
      localWorkspaceInProjects(projects, input.directory)
    ) {
      return undefined
    }
    return optimisticRelayRef(input.workspaceId)
  }
  const workspaceId = workspaceIdFromRef(input.directory)
  if (!workspaceId) {
    // Not a `ws_`/`workspace:` ref — but the directory may still be a
    // relay-backed workspace's FILESYSTEM worktree (the registration-stored
    // remote_directory, which is what session rows carry). Match it against
    // the signed inventory BY DIRECTORY (it normalizes the /private alias).
    // Without this, the pane resolves `local`, the WorkspaceGate never
    // acquires the connection, `isWorkspaceReady` stays false forever, and
    // every workspace-gated query (composer agents, providers) parks even
    // though the workspace is connected.
    const byDirectory = signedWorkspaceFromProjects(projects, input.directory)
    if (!byDirectory) return undefined
    return signedRuntimeRef(byDirectory)
  }
  // UUID-shaped workspace route ids are shared by local and relay-backed
  // workspaces. The project inventory is the authority for that distinction:
  // once it identifies this id as local, a workspace-shaped route must not
  // turn it into a relay target and mint a workspace connection lease.
  if (
    localWorkspaceInProjects(projects, input.directory) ||
    localWorkspaceInProjects(projects, workspaceId)
  ) return undefined
  // Read the REAL kind from the signed inventory. Match by directory AND by the
  // workspace id (`signedWorkspaceFromProjects` matches both forms), so a
  // `workspace:<id>` directory-ref or a raw filesystem path both resolve.
  const signed =
    signedWorkspaceFromProjects(projects, input.directory) ??
    signedWorkspaceFromProjects(projects, workspaceId)
  const signedKind = signed?.kind
  // `workspace:<uuid>` is also the canonical shape emitted by the local
  // sidecar. A prefix does not turn that local association id into a relay
  // workspace. Only typed SessionRef backing (handled above) or the signed
  // inventory may do that. Guessing `machine` here mints a connection for a
  // workspace this server serves itself, on every session mount; the local
  // control plane answers 404 "Workspace not found" and the gate flashes that
  // false failure over an already-loaded session.
  if (!signedKind && localWorkspaceAssociationId(workspaceId)) return undefined
  // When the inventory can't resolve the host, do NOT default to the
  // provisioner: that path runs `prepareWorkspaceRuntime` →
  // `resolveWorkspaceRuntime` → the workspace resolve endpoint, which returns
  // null/HTML for a workspace on an enrolled machine and throws "Workspace
  // runtime is unavailable", concluding OFFLINE for a workspace whose
  // connection mint actually returns 200. Both hosts route through the relay;
  // `machine` uses the mint+health path (no provisioning resolve), which is the
  // source of truth for readiness.
  return { workspaceId, kind: signedKind ?? ("machine" as const), ...(signed?.host ? { host: signed.host } : {}) }
}

export function sessionPaneWorkspaceKey(input: SessionWorkspaceRuntimeInput) {
  return (sessionWorkspaceRuntimeRef(input)?.workspaceId ?? input.directory) || input.sessionRef?.sessionId || ""
}

// Resolve the WorkspaceConnection authority inputs (workspaceId + kind) for a
// pane. A relay-backed workspace returns its real host kind; everything else is
// `self` — no relay backing, so the authority synthesizes
// it ready immediately (the gate is a no-op for loopback). This is the single
// place panes derive the connection kind, so split panes for the same workspace
// agree by construction instead of each re-deriving a (possibly wrong) kind.
export function sessionPaneWorkspaceConnection(
  input: SessionWorkspaceRuntimeInput,
): { workspaceId: string | undefined; kind: WorkspaceHostKind } {
  const ref = sessionWorkspaceRuntimeRef(input)
  if (ref) return { workspaceId: ref.workspaceId, kind: ref.kind }
  return { workspaceId: undefined, kind: "self" }
}
