import { authFetch, getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"
import { createControlPlaneAccountFetch } from "@/platform/account/control-plane-account-fetch"
import type { WorkspaceSessionBacking } from "@/platform/identity/session-ref"

/**
 * The control plane projects (registers, checkpoints, repairs) only the
 * sessions it holds: those of its own cloud workspaces. A user-hosted
 * workspace's sessions live on the machine serving it, which is their
 * authority; the control plane has nothing of theirs to project.
 */
export function sessionProjectionBacking(
  runtime: { workspaceId: string; kind: WorkspaceSessionBacking["kind"] } | undefined,
): WorkspaceSessionBacking | undefined {
  if (!runtime || runtime.kind !== "cloud") return
  return { workspaceId: runtime.workspaceId, kind: runtime.kind }
}
export function sessionProjectionWorkspaceBacking(input: {
  signedControlPlane: boolean
  workspaceId?: string
  workspaceKind?: WorkspaceSessionBacking["kind"]
}): WorkspaceSessionBacking | undefined {
  if (!input.signedControlPlane || !input.workspaceId || !input.workspaceKind) return
  return sessionProjectionBacking({ workspaceId: input.workspaceId, kind: input.workspaceKind })
}

export type SessionProjectionReason =
  | "session-created"
  | "message-checkpoint"
  | "repair"
  | "session-mutated"
  | "sse-gap"

type ProjectionAction = "register" | "checkpoint" | "repair"

export type ProjectionInput = {
  workspaceId?: string
  sessionId?: string
  action: ProjectionAction
  reason: SessionProjectionReason
  serverUrl?: string
  expectedEventOrdinal?: number
  idempotencyKey?: string
  request?: typeof fetch
  /** Test seam: override the retry backoff schedule (ms between attempts). */
  retryDelaysMs?: readonly number[]
}

/**
 * Per-request-key projection state.
 *
 * `inFlight` dedupes concurrent schedules of the same pull. `unsettled` holds a
 * pull whose retries all failed, so a later lifecycle/SSE event or a regained
 * window focus can replay it — a missed sync-back self-heals instead of being
 * lost until reload.
 */
const projections = new Map<string, {
  inFlight?: Promise<boolean>
  unsettled?: ProjectionInput
}>()

function projectionEntry(requestKey: string) {
  const existing = projections.get(requestKey)
  if (existing) return existing
  const created: { inFlight?: Promise<boolean>; unsettled?: ProjectionInput } = {}
  projections.set(requestKey, created)
  return created
}

function pruneProjection(requestKey: string) {
  const entry = projections.get(requestKey)
  if (entry && !entry.inFlight && !entry.unsettled) projections.delete(requestKey)
}

function root(input?: string) {
  return normalizeUrl(input) ?? getClaxedoServerUrl()
}

function key(input: ProjectionInput) {
  return [
    input.action,
    input.workspaceId,
    input.sessionId,
    input.reason,
    input.expectedEventOrdinal ?? "",
    input.idempotencyKey ?? "",
  ].join("\0")
}

function endpoint(input: Required<Pick<ProjectionInput, "workspaceId" | "sessionId" | "action">> & Pick<ProjectionInput, "serverUrl">) {
  return new URL(
    `/api/control/workspaces/${encodeURIComponent(input.workspaceId)}/sessions/${encodeURIComponent(input.sessionId)}/${input.action}`,
    root(input.serverUrl),
  )
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Backoff for a single scheduling attempt. The sync-back is what puts a session
 * into the central store, so a pull that never lands is a session the sidebar can never
 * show once its workspace dies. The old schedule gave up ~4s in, which loses
 * every pull that overlaps a sandbox still booting or a brief network dip.
 */
const RETRY_DELAYS_MS = [0, 1_000, 3_000, 8_000, 20_000]

async function post(input: ProjectionInput) {
  if (!input.workspaceId || !input.sessionId) return false
  const run = input.request ?? createControlPlaneAccountFetch(authFetch)
  const body = {
    idempotencyKey: input.idempotencyKey ?? key(input),
    reason: input.reason,
    ...(input.expectedEventOrdinal === undefined ? {} : { expectedEventOrdinal: input.expectedEventOrdinal }),
  }
  for (const delay of input.retryDelaysMs ?? RETRY_DELAYS_MS) {
    if (delay > 0) await sleep(delay)
    const res = await run(endpoint({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      action: input.action,
      serverUrl: input.serverUrl,
    }), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => undefined)
    if (res?.ok) return true
  }
  return false
}

export function scheduleSessionProjectionPull(input: ProjectionInput) {
  if (!input.workspaceId || !input.sessionId) return
  const requestKey = key(input)
  const entry = projectionEntry(requestKey)
  if (entry.inFlight) return entry.inFlight
  const next = post(input)
    .then((ok) => {
      // A pull that never landed is not lost — park it so the next lifecycle
      // event, SSE gap, or window focus retries it. The endpoint is
      // idempotency-keyed, so replaying a pull that actually succeeded on the
      // server is harmless.
      entry.unsettled = ok ? undefined : input
      return ok
    })
    .finally(() => {
      if (entry.inFlight === next) entry.inFlight = undefined
      pruneProjection(requestKey)
    })
  entry.inFlight = next
  return next
}

/**
 * Re-run every projection pull that previously exhausted its retries.
 *
 * Called on the opportunities the browser actually gets: a later session
 * lifecycle/SSE event, and the window regaining focus or visibility. A missed
 * sync self-heals on the next of these rather than being lost until reload.
 */
export function retryUnsettledSessionProjectionPulls() {
  return [...projections.entries()].flatMap(([requestKey, entry]) => {
    const input = entry.unsettled
    // Still in flight under this key — the live attempt owns the outcome.
    if (!input || entry.inFlight) return []
    entry.unsettled = undefined
    const scheduled = scheduleSessionProjectionPull(input)
    if (!scheduled) pruneProjection(requestKey)
    return scheduled ? [scheduled] : []
  })
}

export function pendingSessionProjectionRetryCount() {
  return [...projections.values()].filter((entry) => !!entry.unsettled).length
}

/** Test seam: drop parked retries so cases do not leak into each other. */
export function resetSessionProjectionRetries() {
  for (const [requestKey, entry] of projections) {
    entry.unsettled = undefined
    pruneProjection(requestKey)
  }
}

type ProjectionEventTarget = {
  addEventListener: (type: string, listener: () => void) => void
  removeEventListener: (type: string, listener: () => void) => void
  visibilityState?: string
}

/**
 * Wire the self-heal triggers the browser owns: `focus`/`online` on the window,
 * `visibilitychange` on the document (that event is dispatched at the document,
 * so listening on the window would never fire). The returned cleanup detaches
 * them.
 */
export function installSessionProjectionSelfHeal(input: {
  window?: ProjectionEventTarget
  document?: ProjectionEventTarget
} = {}) {
  const win = input.window ?? (typeof window === "undefined" ? undefined : window)
  const doc = input.document ?? (typeof document === "undefined" ? undefined : document)
  const retry = () => {
    void retryUnsettledSessionProjectionPulls()
  }
  const onVisibility = () => {
    if (doc?.visibilityState === "hidden") return
    retry()
  }
  win?.addEventListener("focus", retry)
  win?.addEventListener("online", retry)
  doc?.addEventListener("visibilitychange", onVisibility)
  return () => {
    win?.removeEventListener("focus", retry)
    win?.removeEventListener("online", retry)
    doc?.removeEventListener("visibilitychange", onVisibility)
  }
}
