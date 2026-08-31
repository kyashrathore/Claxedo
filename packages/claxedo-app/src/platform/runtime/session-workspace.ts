import { resolveWorkspaceRef } from "@/platform/identity/resolve-workspace-ref"
import type { SessionRef } from "@/platform/identity/session-ref"
import { localWorkspaceAssociationId, workspaceIdFromRef } from "@/platform/identity/legacy-resolver"
import { localWorkspaceInProjects, signedWorkspaceFromProjects } from "@/platform/runtime/agent/signed-workspace"

// The signed project inventory (carries the real cloud-vs-user-hosted `kind` for
// every relay-backed workspace). Threaded in so the resolver can read the kind
// off the inventory instead of guessing it from the directory-ref shape. Shape
// matches `signedWorkspaceFromProjects`'s first arg.
type WorkspaceInventory = Parameters<typeof signedWorkspaceFromProjects>[0]

export type SessionWorkspaceRuntimeInput = {
  directory: string
  sessionRef?: SessionRef
  // Optional signed inventory — when present, the directory-derived path resolves
  // the REAL kind (cloud vs user-hosted) instead of defaulting.
  projects?: WorkspaceInventory
}

export function sessionWorkspaceRuntimeRef(input: SessionWorkspaceRuntimeInput) {
  if (input.sessionRef) {
    const backing = resolveWorkspaceRef(input.sessionRef)
    if (backing.kind === "cloud" || backing.kind === "user-hosted") {
      // Route activation can briefly carry a stale/legacy workspace-backed ref.
      // A loaded project catalog that positively identifies either the backing
      // id or its directory as local is the canonical owner and must win before
      // any connection lease is acquired.
      if (
        localWorkspaceInProjects(input.projects ?? [], backing.workspaceId) ||
        localWorkspaceInProjects(input.projects ?? [], input.directory)
      ) return undefined
      return {
        workspaceId: backing.workspaceId,
        kind: backing.kind,
      }
    }
    // A central/virtual ref (`none` backing) stays unbacked — its workspaceId
    // is an authz-only scope, never a runtime target. But a `local` backing
    // does NOT prove the pane is local: session rows carry the runtime's
    // filesystem cwd (remote_directory), so refs built from them resolve
    // `local` even for relay-backed workspaces. Fall through to the
    // directory/inventory resolution below instead of concluding local here.
    if (backing.kind !== "local") return undefined
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
    const byDirectory = signedWorkspaceFromProjects(input.projects ?? [], input.directory)
    if (!byDirectory) return undefined
    return { workspaceId: byDirectory.workspaceId, kind: byDirectory.kind }
  }
  // Read the REAL kind from the signed inventory. Match by directory AND by the
  // workspace id (`signedWorkspaceFromProjects` matches both forms), so a
  // `workspace:<id>` directory-ref or a raw filesystem path both resolve.
  const signedKind =
    signedWorkspaceFromProjects(input.projects ?? [], input.directory)?.kind ??
    signedWorkspaceFromProjects(input.projects ?? [], workspaceId)?.kind
  // `workspace:<uuid>` is also the canonical shape emitted by the local
  // sidecar. A prefix does not turn that local association id into a relay
  // workspace. Only typed SessionRef backing (handled above) or the signed
  // inventory may do that. Guessing user-hosted here created a connection mint
  // for a local workspace on every session mount; the local control plane
  // correctly answered 404 "Workspace not found", and the gate then flashed
  // that false failure over an already-loaded local session.
  if (!signedKind && localWorkspaceAssociationId(workspaceId)) return undefined
  // When the inventory can't resolve the kind, do NOT default to "cloud": the
  // cloud path runs `prepareWorkspaceRuntime` → `resolveWorkspaceRuntime` →
  // the workspace resolve endpoint, which returns null/HTML for a user-hosted
  // workspace and throws "Workspace runtime is unavailable", concluding OFFLINE
  // for a workspace whose connection mint actually returns 200. Both cloud and
  // user-hosted route through the relay; "user-hosted" uses the mint+health
  // path (no provisioning resolve), which is the source of truth for readiness.
  return { workspaceId, kind: signedKind ?? ("user-hosted" as const) }
}

export function sessionPaneWorkspaceKey(input: SessionWorkspaceRuntimeInput) {
  return (sessionWorkspaceRuntimeRef(input)?.workspaceId ?? input.directory) || input.sessionRef?.sessionId || ""
}

// Resolve the WorkspaceConnection authority inputs (workspaceId + kind) for a
// pane. A relay-backed workspace (cloud / user-hosted) returns its real kind;
// everything else is `local` — no relay backing, so the authority synthesizes
// it ready immediately (the gate is a no-op for loopback). This is the single
// place panes derive the connection kind, so split panes for the same workspace
// agree by construction instead of each re-deriving a (possibly wrong) kind.
export function sessionPaneWorkspaceConnection(
  input: SessionWorkspaceRuntimeInput,
): { workspaceId: string | undefined; kind: "cloud" | "user-hosted" | "local" } {
  const ref = sessionWorkspaceRuntimeRef(input)
  if (ref) return { workspaceId: ref.workspaceId, kind: ref.kind }
  return { workspaceId: undefined, kind: "local" }
}
