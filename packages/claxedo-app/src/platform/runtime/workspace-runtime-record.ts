import { authFetch, getDefaultBaseUrl, normalizeUrl } from "@/platform/api/api"
import { signedAccountRun } from "@/platform/account/hosted-control-call"
import { decodeHostedResult } from "@/platform/account/hosted-operations"
import { localWorkspaceAssociationId, workspaceIdFromRef } from "@/platform/identity/legacy-resolver"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { workspaceResolveUrl } from "@/platform/runtime/agent/workspace-control-routes"
import type { WorkspaceRuntimeSnapshot } from "@/platform/runtime/workspace-runtime"
import { inventoryHostKind } from "@/platform/runtime/placement-wire"
import { asRecord, readNullableString, readString } from "@/lib/record"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { fastSessionSwitchAnyNetworkQuiet } from "@/platform/runtime/session-switch"
import { errorMessage } from "@/lib/server-errors"

export type { WorkspaceRuntimeSnapshot } from "@/platform/runtime/workspace-runtime"

/**
 * Reading the workspace runtime RECORD — which workspace a directory belongs
 * to, what kind it is, and whether it is still coming up.
 *
 * This is not a hosted capability, which is why it does not live under
 * `runtime/cloud/`. The record is served by `http-backend.ts` for every
 * deployment; a local build simply gets `null` (no workspace for the
 * directory, or a 404 from the resolve route) and every caller already handles
 * that. What made it LOOK hosted was its address: it shipped inside
 * `platform/runtime/cloud/workspace-runtime-store.ts`, so fourteen local
 * files — bootstrap, the rail, terminals, processes, review, the session
 * composer and harness — imported a module the cloud extraction has to move.
 *
 * Provisioning a cloud sandbox or connecting to another machine IS a hosted
 * capability, and that half stays behind `workspace-startup-port.ts`. The line
 * between the two files is "read the record" versus "make the runtime exist".
 *
 * The record answers two different questions, so this module exposes two reads
 * over ONE query and one cache entry:
 *
 * - `workspaceRuntimeRoutingRecord` — "which runtime does this directory talk
 *   to". Identity. Cache-first, because it cannot change under a running app.
 * - `resolveWorkspaceRuntime` — "and what state is that runtime in". Liveness.
 *   Revalidates on the query's freshness window.
 *
 * Anything that fetches the record itself instead of going through these will
 * disagree with them; that is not a style point. A private copy in
 * `http-backend.ts` shared this cache key but not the fast-switch policy, and
 * a routing read taken on the liveness path put a control-plane round trip on
 * whatever the user was doing when the freshness window happened to elapse.
 */

/**
 * Collapse a `{ directory, workspaceId }` pair to whichever one identifies the
 * runtime, so a directory that is really a workspace ref resolves by id.
 */
export function runtimeScope(input: { directory?: string; workspaceId?: string }) {
  const workspaceId = input.workspaceId ??
    (input.directory
      ? sessionWorkspaceRuntimeRef({ directory: input.directory })?.workspaceId
      : undefined)
  return {
    workspaceId,
    directory: workspaceId ? undefined : input.directory,
  }
}

export function pendingCloudRuntime(
  input: WorkspaceRuntimeSnapshot | null | undefined,
): input is WorkspaceRuntimeSnapshot & { kind: "provisioner"; status: string } {
  return !!input && input.kind === "provisioner" && !!input.status && input.status !== "ready" && input.status !== "failed"
}

export function workspaceRuntimeBlocksBootstrap(input?: WorkspaceRuntimeSnapshot | null) {
  return pendingCloudRuntime(input)
}

function recordHostKind(value: unknown): WorkspaceRuntimeSnapshot["kind"] {
  const kind = readNullableString(value, "kind")
  if (kind === null) return null
  return inventoryHostKind(kind)
}

/**
 * The record as it arrives on the wire, or `undefined` when the body is not
 * one.
 *
 * Both producers below — the app server's own resolve route over HTTP, and the
 * hosted control plane through the desktop AccountPort — used to reach their
 * callers as a bare assertion, so a body that had changed shape surfaced later
 * as a workspace with nowhere to route. The record is small and fully
 * enumerated by {@link WorkspaceRuntimeSnapshot}, so it is rebuilt from the
 * fields that type declares rather than trusted: a body with no `workspaceId`
 * is not a runtime record at all, which is exactly the "no workspace for this
 * scope" answer both callers already handle.
 *
 * Lives here rather than beside the type because `workspace-runtime.ts` is a
 * type-only module and every product's dependency closure is measured in
 * modules that carry code.
 */
function workspaceRuntimeSnapshotFromWire(raw: unknown): WorkspaceRuntimeSnapshot | undefined {
  const record = asRecord(raw)
  const workspaceId = readString(record, "workspaceId")
  if (!record || !workspaceId) return undefined
  const git = asRecord(record.git)
  return {
    workspaceId,
    projectId: readNullableString(record, "projectId"),
    directory: readString(record, "directory"),
    kind: recordHostKind(record),
    provider: readNullableString(record, "provider"),
    sandboxId: readNullableString(record, "sandboxId"),
    status: readNullableString(record, "status"),
    ...(git
      ? {
          git: {
            repo: readNullableString(git, "repo"),
            branch: readNullableString(git, "branch"),
            remote: readNullableString(git, "remote"),
          },
        }
      : {}),
  }
}

export type WorkspaceRecordScope = {
  baseUrl?: string
  request?: typeof fetch
  directory?: string
  workspaceId?: string
  create?: boolean
}

/**
 * One raw read of the record. The app server owns every filesystem directory it
 * serves and every workspace it hosts, so a scope resolves there first: on the
 * machine that hosts a shared workspace, that workspace is local (the relay
 * exists for other machines). A workspace id the server disowns (404) belongs
 * to the control plane, reached through the desktop AccountPort when signed
 * in; a directory never leaves the server. `null` means "no workspace for this
 * scope" anywhere; any other bad status throws, so a transient failure is
 * never cached as a real "no workspace".
 */
export async function fetchWorkspaceRecord(input: WorkspaceRecordScope): Promise<WorkspaceRuntimeSnapshot | null> {
  const served = await fetchWorkspaceRecordHttp(input)
  if (served || input.request) return served
  const workspaceId = input.workspaceId
    ?? workspaceIdFromRef(input.directory)
    ?? localWorkspaceAssociationId(input.directory)
  if (!workspaceId) return null
  const run = await signedAccountRun()
  if (!run) return null
  try {
    return workspaceRuntimeSnapshotFromWire(decodeHostedResult(
      "workspace.resolve",
      await run("workspace.resolve", { workspaceId, ...(input.create ? { create: true } : {}) }),
    )) ?? null
  } catch (err) {
    const message = errorMessage(err)
    if (/operation "workspace\.resolve" failed: 404\b/.test(message) || /\bfailed: 404\b/.test(message)) {
      return null
    }
    throw err
  }
}

async function fetchWorkspaceRecordHttp(input: WorkspaceRecordScope): Promise<WorkspaceRuntimeSnapshot | null> {
  const baseUrl = normalizeUrl(input.baseUrl) ?? getDefaultBaseUrl()
  const request = input.request ?? authFetch
  const res = await request(
    workspaceResolveUrl({ baseUrl, scope: input.directory, workspaceId: input.workspaceId, create: input.create }),
    { headers: { Accept: "application/json" } },
  )
  if (res.status === 404) return null
  if (!res.ok) throw new Error((await res.text()) || `Request failed: ${res.status}`)
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error("Workspace runtime is unavailable.")
  }
  // A 200 whose body is not a runtime record is the same answer as a 404: this
  // scope has no workspace here. `fetchWorkspaceRecord` then falls through to
  // the hosted control plane rather than handing callers a row with no id.
  return workspaceRuntimeSnapshotFromWire(body) ?? null
}

/** The shared cache entry every record read goes through. */
export function workspaceResolveQuery(input: WorkspaceRecordScope) {
  return {
    queryKey: queryKeys.runtime.workspace(input),
    staleTime: 15 * 1000,
    queryFn: async () => await fetchWorkspaceRecord(input),
  }
}

/** The same entry, with a directory that is really a workspace ref collapsed to its id. */
function scopedWorkspaceResolveQuery(input: WorkspaceRecordScope) {
  return workspaceResolveQuery({ ...input, ...runtimeScope(input) })
}

/**
 * The record as ROUTING IDENTITY: which workspace runtime backs this directory,
 * and how to reach it. Answers from cache whenever an answer exists, and
 * fetches only when there is none.
 *
 * Not expiring on a clock is the point. A directory's backing workspace does
 * not change while the app runs — creating or re-homing one goes through
 * `ensureLocalProject`, which INVALIDATES this key, and an invalidated entry is
 * stale whatever its staleTime says, so this read still refetches then. What
 * it no longer does is refetch merely because time passed, which cost real
 * user time: the session environment card resolves the record on every 5s
 * processes poll, so roughly every third poll crossed the freshness window and
 * issued a control-plane resolve, landing on whatever the user was doing at
 * that instant. Measured as a same-workspace session switch that
 * intermittently issued one workspace-class request the switch could not
 * explain.
 */
export async function workspaceRuntimeRoutingRecord(input: WorkspaceRecordScope) {
  return await queryClient.fetchQuery({ ...scopedWorkspaceResolveQuery(input), staleTime: Infinity })
}

/**
 * The record already in cache for this scope, or `undefined` when there is
 * none — never a request.
 *
 * For callers whose read is pure warm-up: they want the record if it is
 * already known, but have no claim on a control-plane round trip. Owned here
 * rather than by the caller so the scoped cache key stays private to this
 * module; a caller that hashes the key itself is how a second entry for one
 * record gets created.
 */
export function cachedWorkspaceRuntimeRecord(input: WorkspaceRecordScope) {
  return queryClient.getQueryData<WorkspaceRuntimeSnapshot | null>(scopedWorkspaceResolveQuery(input).queryKey)
}

/**
 * The record as LIVENESS: the same identity, plus whether the runtime is ready,
 * still coming up, or stopped. Revalidates on the query's freshness window,
 * because the answer is a state the control plane owns and changes without
 * telling us.
 *
 * Fast-switch policy: during a session activation's network-quiet window a
 * directory read answers from cache or not at all. The switch cannot learn
 * anything from a control-plane round trip it has to wait for — the record for
 * a directory the user is already looking at does not change mid-click — and
 * paying one inside the switch window is exactly what made the same-workspace
 * stability gate flap. `workspaceId` reads and `create` are exempt: they are
 * routing/provisioning, not the switch's own bookkeeping.
 */
export async function resolveWorkspaceRuntime(input: WorkspaceRecordScope) {
  const query = scopedWorkspaceResolveQuery(input)
  if (fastSessionSwitchAnyNetworkQuiet() && input.directory && !input.workspaceId && input.create !== true) {
    const cached = queryClient.getQueryData<WorkspaceRuntimeSnapshot | null>(query.queryKey)
    if (cached !== undefined) return cached
    return null
  }
  return await queryClient.fetchQuery(query)
}
