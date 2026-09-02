import { createStore, produce, type SetStoreFunction } from "solid-js/store"
import type { CloudLog } from "@/features/session/ui/components/cloud-startup-view"
import { isForbiddenConnectionError } from "@/features/workspaces/app-ports"
import type { useClaxedoEventsOptional } from "../../../app/integrations/claxedo-events"
import { appendWorkspaceRuntimeLog } from "@/platform/runtime/workspace-log"
// This module is hosted, so it imports the implementation directly rather
// than through `workspaceStartup()`. Local surfaces must not copy this import.
import {
  prepareUserHostedRuntime,
  prepareWorkspaceRuntime,
} from "@/platform/runtime/cloud/workspace-runtime-store"
import {
  forgetWorkspaceConnection,
  openWorkspaceConnection,
  setWorkspaceConnectionObserver,
  type WorkspaceConnectionInfo,
} from "@/platform/runtime/agent/workspace-relay-connection"
import {
  placementFromWorkspaceConnection,
  type Placement,
  type RelayRole,
} from "@/platform/runtime/placement"
import {
  transitionConnectionPlacement,
  type ConnectionPlacementEvent,
  type ConnectionPlacementState,
} from "@/platform/runtime/connection-placement"

// One connection authority keyed by `workspaceId`. Every consumer — every
// session pane, the Review panel, the model/agent/messages/diff queries, the
// event stream, the toast sites, the retry loops — subscribes to THIS instead
// of independently rediscovering "is the workspace connected?".
//
// This module is the SINGLE WRITER. The drive loop reuses the existing mint /
// health-probe / provision code verbatim (`prepareUserHostedRuntime` /
// `prepareWorkspaceRuntime`, which themselves flow through
// `openWorkspaceConnection`'s cooldown circuit-breaker) — it centralizes *who
// calls it*, not *what it does*.

export type WorkspaceConnectionKind = "cloud" | "user-hosted" | "local"

export type WorkspaceOfflineReason =
  // user-hosted: host machine offline (503 user_hosted_app_offline)
  | "no-host"
  // mint 403 / 401 — not your workspace (terminal)
  | "forbidden"
  // relay/runtime unreachable (502/509/network/timeout)
  | "unreachable"
  // the sandbox is still provisioning but the client's poll budget ran out —
  // the workspace did NOT fail; retrying resumes the wait
  | "still-provisioning"
  // generic mint/provision failure (4xx/5xx not above)
  | "failed"

type OfflineStatus = { offline: WorkspaceOfflineReason }

export type WorkspaceConnectionStatus =
  // mint + health/provision in flight, first connect
  | "connecting"
  // runtime reachable; workspace queries may run
  | "ready"
  // was ready, transient drop; queries paused, no teardown
  | "reconnecting"
  | OfflineStatus

export type WorkspaceConnectionState = {
  workspaceId: string
  kind: WorkspaceConnectionKind
  status: WorkspaceConnectionStatus
  // Progress surfaced to WorkspaceGate's connecting UI (replaces the per-gate
  // startupStatus/logs signals). Same shape CloudStartupView consumes.
  phase?: string
  logs: CloudLog[]
  err?: string
  // Terminal vs transient — controls whether the gate offers Retry and whether
  // the authority auto-retries. Mirrors the cooldown classification in
  // workspace-relay-connection.ts (`connectionFailureCooldownMs`).
  terminal: boolean
  // Reference count of mounted subscribers (panes/panels) for this workspaceId.
  // The connection is opened on first subscribe and torn down on last.
  refs: number
  rolePlacement: ConnectionPlacementState
  relayPlacement?: Placement
}

type EventsApi = ReturnType<typeof useClaxedoEventsOptional>

export type AcquireWorkspaceConnectionInput = {
  workspaceId: string
  kind: WorkspaceConnectionKind
  directory?: string
  baseUrl?: string
  request?: typeof fetch
  relayRequest?: typeof fetch
  // The cloud drive loop listens to `events?.on("provision")` for runtime
  // startup phases — passed through to `prepareWorkspaceRuntime` unchanged.
  events?: EventsApi
}

// Internal per-entry bookkeeping that must NOT live in the reactive store
// (cancellation flags, pending teardown timers, the acquire input for retry).
type ConnectionRuntime = {
  input: AcquireWorkspaceConnectionInput
  // Bumped on every (re)drive so a stale in-flight loop can no-op its writes.
  generation: number
  teardownTimer?: ReturnType<typeof globalThis.setTimeout>
}

// ─── Store (single writer) ──────────────────────────────────────────────────

const [connections, setConnections] = createStore<Record<string, WorkspaceConnectionState>>({})
const runtimes = new Map<string, ConnectionRuntime>()

// E2E/debug escape hatch: lets browser automation inspect and drive the live
// connection authority without rebuilding. Mirrors __claxedoQueryClient.
if (typeof window !== "undefined") {
  ;(window as typeof window & { __claxedoConnections?: unknown }).__claxedoConnections = {
    snapshot: () => JSON.parse(JSON.stringify(connections)),
    runtimes: () => [...runtimes.entries()].map(([id, rt]) => ({ id, generation: rt.generation, teardown: !!rt.teardownTimer })),
    // Gated on DEV OR a prebuilt e2e bundle (`VITE_CLAXEDO_E2E==="1"`, baked at
    // build): CI serves a production build via `vite preview`, where
    // `import.meta.env.DEV` is false, so gating on DEV alone strips these drive
    // hatches and the reconnect/role specs can't drive their transitions. Stripped
    // from real production, which never sets the flag.
    ...(import.meta.env.DEV || import.meta.env.VITE_CLAXEDO_E2E === "1"
      ? {
          markReconnecting: markWorkspaceReconnecting,
          markReconnected: markWorkspaceReconnected,
          // Drives the role-placement transition a live token refresh would apply
          // (`{type:"role"}`, the same event `applyWorkspaceConnectionInfo` feeds on a
          // real connect/refresh). Exposed for e2e because the production refresh that
          // carries a re-minted role never fires from a loopback-served harness — its
          // relay-direct fetch is bridged through the central server — so a role
          // live-flip can only be driven deterministically through this seam. It goes
          // through the real placement state machine, so the composer's role gate
          // unlocks exactly as it would in production.
          markRole: (workspaceId: string, role: RelayRole) =>
            applyPlacementEvent(workspaceId, { type: "role", role }),
        }
      : {}),
  }
}

// Debounce teardown so fast pane swaps / split re-layout (mount→unmount→mount in
// the same frame) do not tear down and re-mint a healthy connection.
const TEARDOWN_DEBOUNCE_MS = 5_000
const RECENT_READY_TTL_MS = 60_000
const RECENT_READY_STORAGE_KEY = "claxedo.workspace-connection.ready.v1"

// ─── Reactive read accessors (the ONLY way consumers read status) ────────────

export function workspaceConnection(workspaceId: string | undefined): WorkspaceConnectionState | undefined {
  if (!workspaceId) return undefined
  return connections[workspaceId]
}

export function isWorkspaceReady(workspaceId: string | undefined): boolean {
  if (!workspaceId) return false
  return connections[workspaceId]?.status === "ready"
}

export function isWorkspaceConnecting(workspaceId: string | undefined): boolean {
  if (!workspaceId) return false
  const status = connections[workspaceId]?.status
  return status === "connecting" || status === "reconnecting"
}

export function workspaceOffline(workspaceId: string | undefined): WorkspaceOfflineReason | undefined {
  if (!workspaceId) return undefined
  const status = connections[workspaceId]?.status
  return isOfflineStatus(status) ? status.offline : undefined
}

export function connectionPlacement(workspaceId: string | undefined): ConnectionPlacementState | undefined {
  if (!workspaceId) return undefined
  return connections[workspaceId]?.rolePlacement
}

export function workspacePlacement(workspaceId: string | undefined): Placement | undefined {
  if (!workspaceId) return undefined
  const state = connections[workspaceId]
  if (!state?.relayPlacement) return undefined
  const role = roleFromPlacementState(state.rolePlacement)
  return role ? { ...state.relayPlacement, role } : undefined
}

function isOfflineStatus(status: WorkspaceConnectionStatus | undefined): status is OfflineStatus {
  return !!status && typeof status === "object" && "offline" in status
}

// ─── Classification (mirrors workspace-relay-connection.ts cooldowns) ─────────

// Terminal failures (401/403/404/409) will not become reachable by retrying;
// the gate hides Retry and the authority does not auto-retry. Transient
// failures (429/5xx/network) may succeed once the host/runtime comes online.
function isTerminalReason(reason: WorkspaceOfflineReason): boolean {
  return reason === "forbidden"
}

function roleFromPlacementState(state: ConnectionPlacementState): RelayRole | undefined {
  if (state.state === "role-known" || state.state === "reconnecting" || state.state === "disconnected") return state.role
  return undefined
}

// Map a failed user-hosted/cloud drive outcome to an offline reason.
function classifyOffline(input: { offline?: boolean; message?: string }): WorkspaceOfflineReason {
  if (isForbiddenConnectionError(input.message)) return "forbidden"
  if (input.offline) return "no-host"
  // The connection poll gave up while the server still said "provisioning"
  // (workspace-relay-connection.ts's attempt cap). The sandbox is still being
  // prepared server-side — presenting this as a failure would be a lie.
  if (input.message && /still provisioning/i.test(input.message)) return "still-provisioning"
  if (input.message && /\b(502|503|509)\b/.test(input.message)) return "unreachable"
  if (input.message && /timeout|unreachable|network|aborted|ECONN/i.test(input.message)) return "unreachable"
  return "failed"
}

// ─── Single-writer transition helpers ────────────────────────────────────────

function setOffline(workspaceId: string, reason: WorkspaceOfflineReason, message?: string) {
  setConnections(
    workspaceId,
    produce((state) => {
      if (!state) return
      state.status = { offline: reason }
      state.terminal = isTerminalReason(reason)
      state.phase = "error"
      if (message !== undefined) state.err = message
    }),
  )
  applyPlacementEvent(workspaceId, { type: "lost" })
}

function setReady(workspaceId: string) {
  setConnections(
    workspaceId,
    produce((state) => {
      if (!state) return
      state.status = "ready"
      state.terminal = false
      state.phase = "ready"
      state.err = undefined
    }),
  )
  applyPlacementEvent(workspaceId, { type: "connected" })
  rememberRecentReady(workspaceId)
}

function applyPlacementEvent(workspaceId: string, event: ConnectionPlacementEvent) {
  setConnections(
    workspaceId,
    produce((state) => {
      if (!state) return
      const next = transitionConnectionPlacement(state.rolePlacement, event)
      if (next) state.rolePlacement = next
    }),
  )
}

function applyWorkspaceConnectionInfo(info: WorkspaceConnectionInfo) {
  setConnections(
    info.workspaceId,
    produce((state) => {
      if (!state) return
      state.relayPlacement = placementFromWorkspaceConnection(info)
      const next = transitionConnectionPlacement(state.rolePlacement, { type: "role", role: info.role })
      if (next) state.rolePlacement = next
    }),
  )
}

setWorkspaceConnectionObserver({
  onConnected: applyWorkspaceConnectionInfo,
  onFailed: (workspaceId) => applyPlacementEvent(workspaceId, { type: "lost" }),
  // Provisioning polls now say WHAT the sandbox manager is doing. Mapped onto
  // the existing phase vocabulary so CloudStartupView needs no new plumbing:
  // restore/resume get their own honest steps; cold-start keeps the generic
  // acquiring phase (the provision SSE stream then narrates cloning etc.).
  onProvisioning: (workspaceId, bootMode) => {
    if (bootMode === "restore") applyStatus(workspaceId, "restoring_snapshot")
    else if (bootMode === "resume") applyStatus(workspaceId, "resuming_sandbox")
  },
})

function applyStatus(workspaceId: string, phase: string) {
  setConnections(
    workspaceId,
    produce((state) => {
      if (!state) return
      state.phase = phase
      if (phase === "acquiring_sandbox" && state.err) state.err = undefined
    }),
  )
}

function applyLog(workspaceId: string, log: CloudLog) {
  setConnections(
    workspaceId,
    produce((state) => {
      if (!state) return
      state.logs = appendWorkspaceRuntimeLog(state.logs, log.step, log.message, log.totalMs, log.ts)
      if (log.step === "error" && log.message) state.err = log.message
    }),
  )
}

// ─── Drive loop (reuses existing mint / health / provision code) ──────────────

function driveConnection(workspaceId: string, runtime: ConnectionRuntime, options?: { keepReadyWhileChecking?: boolean }) {
  const generation = (runtime.generation += 1)
  const cancelled = () => runtimes.get(workspaceId)?.generation !== generation
  const input = runtime.input

  // `local` workspaces have no relay backing — there is nothing to connect to,
  // so they are synthesized ready immediately. This subsumes the scattered
  // `!workspaceId → true` branches across the old gates.
  if (input.kind === "local") {
    setReady(workspaceId)
    return
  }

  if (!options?.keepReadyWhileChecking) {
    setConnections(
      workspaceId,
      produce((state) => {
        if (!state) return
        // A redrive from offline → connecting (retry) keeps the same entry but
        // clears the terminal failure surface.
        state.status = "connecting"
        state.terminal = false
        state.err = undefined
        state.phase = input.kind === "user-hosted" ? "connecting_workspace" : "acquiring_sandbox"
      }),
    )
  }

  if (input.kind === "user-hosted") {
    void prepareUserHostedRuntime({
      workspaceId,
      ...(input.directory ? { directory: input.directory } : {}),
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      ...(input.request ? { request: input.request } : {}),
      ...(input.relayRequest ? { relayRequest: input.relayRequest } : {}),
      cancelled,
      onStatus: (status) => {
        if (cancelled()) return
        applyStatus(workspaceId, status)
      },
      onLog: (log) => {
        if (cancelled()) return
        applyLog(workspaceId, log)
      },
      onOffline: (next) => {
        if (cancelled()) return
        setOffline(workspaceId, "no-host", next.message)
      },
    })
      .then(async (result) => {
        if (cancelled()) return
        if (result.ok) {
          // The health transport mints through `openWorkspaceConnection`. If a
          // runtime consumer populated that shared cache before this authority
          // entry existed, its observer event had nowhere to apply the role.
          // Read the canonical cached/minted connection now, just as the cloud
          // path below does, so `ready` is never paired with `role-pending`.
          const connection = await openWorkspaceConnection(workspaceId, {
            ...(input.baseUrl ? { serverUrl: input.baseUrl } : {}),
            ...(input.request ? { request: input.request } : {}),
          })
          if (cancelled()) return
          applyWorkspaceConnectionInfo(connection)
          setReady(workspaceId)
          return
        }
        const reason = classifyOffline({ offline: result.offline, message: result.message })
        setOffline(workspaceId, reason, result.message ?? "Could not connect to the workspace.")
      })
      .catch((err) => {
        if (cancelled()) return
        const message = err instanceof Error ? err.message : String(err)
        setOffline(workspaceId, classifyOffline({ message }), message)
      })
    return
  }

  // kind: "cloud" — requires a directory to resolve the central sandbox.
  if (!input.directory) {
    setOffline(workspaceId, "failed", "Missing workspace directory for cloud runtime.")
    return
  }

  void prepareWorkspaceRuntime({
    directory: input.directory,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.request ? { request: input.request } : {}),
    events: input.events,
    cancelled,
    onResolved: (workspace) => {
      if (cancelled()) return
      if (!workspace || workspace.kind !== "cloud" || workspace.status === "ready") {
        setReady(workspaceId)
      }
    },
    onStatus: (status) => {
      if (cancelled()) return
      applyStatus(workspaceId, status)
    },
    onLog: (log) => {
      if (cancelled()) return
      applyLog(workspaceId, log)
    },
  })
    .then(async (result) => {
      if (cancelled()) return
      if (result.ok) {
        const connection = await openWorkspaceConnection(workspaceId, {
          ...(input.baseUrl ? { serverUrl: input.baseUrl } : {}),
          ...(input.request ? { request: input.request } : {}),
        })
        if (cancelled()) return
        // Another runtime consumer can mint and cache this connection before
        // the reactive authority creates its entry. The global observer cannot
        // apply that early role to a missing entry, and cached opens do not emit
        // a second observer event. Consume the authoritative return value here
        // as well so ready never means "role still pending".
        applyWorkspaceConnectionInfo(connection)
        setReady(workspaceId)
        return
      }
      const message = result.message ?? "Workspace startup failed."
      setOffline(workspaceId, classifyOffline({ message }), message)
    })
    .catch((err) => {
      if (cancelled()) return
      const message = err instanceof Error ? err.message : String(err)
      setOffline(workspaceId, classifyOffline({ message }), message)
    })
}

// ─── The single exported mutator: acquire (ref-counted) ──────────────────────

export function acquireWorkspaceConnection(input: AcquireWorkspaceConnectionInput): { release: () => void } {
  const { workspaceId } = input
  const existing = runtimes.get(workspaceId)

  if (existing && connections[workspaceId]) {
    // Shared connection — split panes over the same workspaceId fan into ONE
    // drive loop / one mint / one health loop / one provision listener.
    if (existing.teardownTimer) {
      globalThis.clearTimeout(existing.teardownTimer)
      existing.teardownTimer = undefined
    }
    const previous = existing.input
    existing.input = mergeInput(existing.input, input)
    const changed =
      previous.kind !== existing.input.kind ||
      previous.directory !== existing.input.directory ||
      previous.baseUrl !== existing.input.baseUrl ||
      previous.request !== existing.input.request ||
      previous.relayRequest !== existing.input.relayRequest ||
      previous.events !== existing.input.events
    setConnections(
      workspaceId,
      produce((state) => {
        if (!state) return
        state.refs += 1
        state.kind = existing.input.kind
      }),
    )
    if (changed) {
      driveConnection(workspaceId, existing, {
        keepReadyWhileChecking: connections[workspaceId]?.status === "ready",
      })
    }
    return { release: () => releaseWorkspaceConnection(workspaceId) }
  }

  const runtime: ConnectionRuntime = { input, generation: 0 }
  const warmUserHosted = input.kind === "user-hosted" && wasRecentlyReady(workspaceId)
  runtimes.set(workspaceId, runtime)
  setConnections(workspaceId, {
    workspaceId,
    kind: input.kind,
    // From frame zero: connecting (or ready for local). No blank fall-through.
    status: input.kind === "local" || warmUserHosted ? "ready" : "connecting",
    phase: input.kind === "local" || warmUserHosted
      ? "ready"
      : input.kind === "user-hosted"
        ? "connecting_workspace"
        : "acquiring_sandbox",
    logs: [],
    terminal: false,
    refs: 1,
    rolePlacement: input.kind === "local"
      ? { state: "role-known", workspaceId, role: "owner" }
      : { state: "role-pending", workspaceId },
    ...(input.kind === "local"
      ? { relayPlacement: { workspaceId, hosting: "workspace", transport: "loopback", role: "owner" } satisfies Placement }
      : {}),
  })
  driveConnection(workspaceId, runtime, { keepReadyWhileChecking: warmUserHosted })
  return { release: () => releaseWorkspaceConnection(workspaceId) }
}

// Later acquires for the same workspaceId may carry a directory/events the
// first acquire lacked (e.g. a split pane that knows the cwd). Fill in missing
// fields without downgrading what we already have.
function mergeInput(
  prev: AcquireWorkspaceConnectionInput,
  next: AcquireWorkspaceConnectionInput,
): AcquireWorkspaceConnectionInput {
  return {
    workspaceId: prev.workspaceId,
    kind: refinedKind(prev.kind, next.kind),
    directory: prev.directory ?? next.directory,
    baseUrl: prev.baseUrl ?? next.baseUrl,
    request: prev.request ?? next.request,
    relayRequest: prev.relayRequest ?? next.relayRequest,
    events: prev.events ?? next.events,
  }
}

/**
 * Merge two `kind` readings for the SAME `workspaceId` — never a downgrade.
 *
 * `local` never survives a second, more-specific reading: it is what a caller
 * reports before it has resolved anything relay-backed, so any non-local
 * `next` wins over it.
 *
 * Once a workspace has been read as `cloud`, a later `user-hosted` reading is
 * NOT more specific — it is `sessionWorkspaceRuntimeRef`'s deliberate "never
 * guess cloud" default (see `platform/runtime/session-workspace.ts`) landing
 * on a caller whose own inventory read has not resolved yet. `cloud` is the
 * confirmed value in that pair, so it is the one direction this merge treats
 * asymmetrically: `cloud` sticks, `user-hosted` does not get to overwrite it.
 * Every other pairing (equal kinds, or `user-hosted` refined to a
 * subsequently-confirmed `cloud`) takes `next`.
 */
function refinedKind(prev: WorkspaceConnectionKind, next: WorkspaceConnectionKind): WorkspaceConnectionKind {
  if (prev === "cloud" && next === "user-hosted") return prev
  if (prev === "local" && next !== "local") return next
  return next
}

function releaseWorkspaceConnection(workspaceId: string) {
  const state = connections[workspaceId]
  const runtime = runtimes.get(workspaceId)
  if (!state || !runtime) return
  const nextRefs = state.refs - 1
  if (nextRefs > 0) {
    setConnections(workspaceId, "refs", nextRefs)
    return
  }
  setConnections(workspaceId, "refs", 0)
  // Debounced teardown — survive fast pane swaps / split re-layout.
  runtime.teardownTimer = globalThis.setTimeout(() => {
    const current = connections[workspaceId]
    // A re-acquire in the debounce window bumped refs back up — abort teardown.
    if (current && current.refs > 0) return
    teardownWorkspaceConnection(workspaceId)
  }, TEARDOWN_DEBOUNCE_MS)
}

function teardownWorkspaceConnection(workspaceId: string) {
  const runtime = runtimes.get(workspaceId)
  if (runtime) {
    // Bump generation so any in-flight drive loop no-ops its writes.
    runtime.generation += 1
    if (runtime.teardownTimer) globalThis.clearTimeout(runtime.teardownTimer)
    runtimes.delete(workspaceId)
  }
  // Teardown does NOT evict the relay-connection cache — that has its own TTL
  // eviction inside `openWorkspaceConnection`.
  setConnections(
    produce((map) => {
      delete map[workspaceId]
    }),
  )
}

// ─── Retry (user-driven, or auto for transient after cooldown) ────────────────

export function retryWorkspaceConnection(workspaceId: string | undefined) {
  if (!workspaceId) return
  const runtime = runtimes.get(workspaceId)
  const state = connections[workspaceId]
  if (!runtime || !state) return
  // Terminal failures (forbidden) never retry — the gate hides the button, but
  // guard here too so a programmatic call can't restart a doomed mint.
  if (state.terminal) return
  forgetWorkspaceConnection(workspaceId)
  applyPlacementEvent(workspaceId, { type: "retry" })
  driveConnection(workspaceId, runtime)
}

// ─── Event-stream → authority bridge (Step 6 wiring seam) ─────────────────────

// A sustained workspace event-stream failure nudges ready → reconnecting
// (queries park, NO teardown); recovery flips reconnecting → ready. Exposed so
// `context/claxedo-events.tsx` can feed its per-target reconnect outcome to
// the authority instead of inferring readiness independently.
export function markWorkspaceReconnecting(workspaceId: string | undefined) {
  if (!workspaceId) return
  const state = connections[workspaceId]
  if (!state || state.status !== "ready") return
  setConnections(workspaceId, "status", "reconnecting")
  applyPlacementEvent(workspaceId, { type: "lost" })
}

export function markWorkspaceReconnected(workspaceId: string | undefined) {
  if (!workspaceId) return
  const state = connections[workspaceId]
  if (!state || state.status !== "reconnecting") return
  setConnections(workspaceId, "status", "ready")
  applyPlacementEvent(workspaceId, { type: "connected" })
}

// ─── Test-only access (not part of the consumer contract) ─────────────────────

// Exposed for unit tests to assert the single-writer invariant indirectly and
// to reset module state between cases. NOT for UI consumers — the invariants
// test pins that no UI code calls these.
export const __workspaceConnectionInternals = {
  reset() {
    for (const id of Object.keys(connections)) {
      const runtime = runtimes.get(id)
      if (runtime?.teardownTimer) globalThis.clearTimeout(runtime.teardownTimer)
    }
    runtimes.clear()
    setConnections(produce((map) => {
      for (const id of Object.keys(map)) delete map[id]
    }))
  },
  setState: setConnections as SetStoreFunction<Record<string, WorkspaceConnectionState>>,
  snapshot: () => connections,
  classifyOffline,
  isTerminalReason,
  applyPlacementEvent,
  applyWorkspaceConnectionInfo,
  rememberRecentReady,
  wasRecentlyReady,
}

function readRecentReady() {
  if (typeof localStorage === "undefined") return {}
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_READY_STORAGE_KEY) ?? "{}") as Record<string, number>
    return value && typeof value === "object" ? value : {}
  } catch {
    return {}
  }
}

function rememberRecentReady(workspaceId: string) {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(RECENT_READY_STORAGE_KEY, JSON.stringify({
      ...readRecentReady(),
      [workspaceId]: Date.now(),
    }))
  } catch {
    // Storage can be unavailable in private contexts; the connection authority
    // still works, it just cannot warm-start after reload.
  }
}

function wasRecentlyReady(workspaceId: string) {
  const at = readRecentReady()[workspaceId]
  return typeof at === "number" && Date.now() - at < RECENT_READY_TTL_MS
}
