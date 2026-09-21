import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { configureWorkspaceStore, updateWorkspace, getWorkspace, type Workspace } from "@claxedo/server-core/workspace/store/index"
import { configureWorkspaceSupervisorPort } from "@claxedo/server-core/workspace/supervisor-port"
import { IDLE_MS, now } from "./clock"
import {
  pushRuntimeConfig,
  runtimeHasActiveWork,
} from "./config-sync"
import {
  captureSupervisorSandboxCheckpoint,
  recordSupervisorRuntimeSnapshot,
  resolveSandboxBindings,
  restoreSupervisorSandboxCheckpoint,
  sandboxAuthoritySatisfied,
  startSandbox,
  stopSandbox,
  touchSandbox,
  type SandboxBindings,
} from "./sandbox"
import {
  acquireSupervisorSandboxHold,
  cleanExpiredSupervisorSandboxHolds,
  createSupervisorSandboxLeaseStore,
  getSupervisorSandboxLease,
  listSupervisorSandboxLeases,
  releaseSupervisorSandboxHold,
  releaseSupervisorSandboxLease,
  updateSupervisorSandboxLease,
  sandboxLeaseFromRow,
  sandboxLeaseStatus,
  sandboxTargetFromLease,
} from "../../sandbox/stores/sqlite-supervisor-state"
import {
  clearRuntimeStop,
  runtimeState,
  runtimeWorkspaceDir,
} from "./state"
import { runtimes, type WorkspaceRuntimeState } from "./store"
import type {
  SandboxEnsureResult,
  SandboxLease,
  SandboxManager,
  SandboxTarget,
  SandboxTargetResult,
} from "@claxedo/sandbox-manager"
import type { SandboxLeaseRow } from "@claxedo/sandbox-manager/lease-types"
import {
  configureWorkspaceSupervisorOptions,
  workspaceSupervisorServerUrl,
} from "./options"
import type { WorkspaceSupervisorOptions } from "./runtime-env"

export { verifyWorkspaceRuntimeControlToken } from "./control-token"
export { workspaceSupervisorServerUrl }

const log = Log.create({ service: "workspace-supervisor" })

export function configureWorkspaceSupervisor(input: WorkspaceSupervisorOptions) {
  configureWorkspaceSupervisorOptions(input)
  // The supervisor owns sandbox leases, so it is the one that can teach the
  // workspace store to read them. Wiring the store to import the lease table
  // directly would put the cloud sandbox graph inside the closure of every
  // module that reads local workspace inventory. A composition without a
  // supervisor has no cloud workspaces, so it needs no reader.
  configureWorkspaceStore({ sandboxLease: (workspaceId) => getSupervisorSandboxLease(workspaceId) })
  // Local request paths speak to the supervisor through a seven-method port so
  // they do not import the cloud provisioning graph to say "still in use".
  configureWorkspaceSupervisorPort({
    hold: holdSupervisorSandbox,
    release: releaseSupervisorSandbox,
    markUse: markSupervisorSandboxUse,
    touch: touchSupervisorSandbox,
    broadcastRuntimeConfig,
    reconcileCredentialDelivery,
  })
}

export async function ensureSupervisorSandbox(workspaceId: string, bindings?: SandboxBindings) {
  const ws = await getWorkspace(workspaceId)
  if (!ws) throw new Error(`workspace not found: ${workspaceId}`)
  const entry = await startRuntime(runtimeState(ws), bindings)
  entry.used_at = now()
  scheduleStop(entry)
  return entry
}

export async function syncSupervisorSandbox(workspaceId: string) {
  const entry = await ensureSupervisorSandbox(workspaceId)
  await pushRuntimeConfig(entry)
  return entry
}

async function ensureRelayProtectedSandbox(
  workspaceId: string,
  hostId: string,
  bindings?: SandboxBindings,
) {
  if (!hostId.trim()) throw new Error("host id required")
  const ws = await getWorkspace(workspaceId)
  if (!ws) throw new Error(`workspace not found: ${workspaceId}`)
  const entry = runtimeState(ws)
  if (entry.relay_host_id && entry.relay_host_id !== hostId) {
    throw new Error(`sandbox mismatch: ${workspaceId}`)
  }
  entry.relay_host_id = hostId
  const started = await startRuntime(entry, bindings)
  if (started.sandbox_target) {
    started.sandbox_target = {
      ...started.sandbox_target,
      hostId,
    }
  }
  started.used_at = now()
  scheduleStop(started)
  return started
}

export async function broadcastRuntimeConfig() {
  await Promise.allSettled(
    [...runtimes.values()]
      .filter((item) => item.status === "ready" && item.url)
      .map((item) => pushRuntimeConfig(item)),
  )
}

/**
 * The credential authority's delivered set changed — an account was revoked,
 * removed, rotated, re-scoped or re-selected. Every sandbox this supervisor
 * keeps up is re-ensured through the same path a wake takes: a ready lease
 * whose installed set no longer matches goes back through the driver, where a
 * name absent from the set is withdrawn at the provider edge, and the fresh
 * projection is pushed so the runtime stops offering the account.
 */
export async function reconcileCredentialDelivery() {
  await Promise.allSettled(
    [...runtimes.values()]
      .filter((item) => (item.status === "ready" && item.url) || item.start)
      .map((item) => reconcileRuntimeCredentialDelivery(item)),
  )
}

async function reconcileRuntimeCredentialDelivery(state: WorkspaceRuntimeState) {
  try {
    if (state.ws.kind !== "cloud") {
      // No provider edge holds a local runtime's credentials — the loopback
      // broker refuses a revoked account on its next resolve — so the push is
      // the whole reconcile here.
      await pushRuntimeConfig(state)
      return
    }
    // A start already in flight resolved its authority before this change and
    // can settle having installed the stale set, so satisfaction is checked
    // after each pass rather than assumed from one ensure.
    let settled = false
    for (let pass = 0; pass < 2 && !settled; pass++) {
      await startRuntime(state)
      settled = sandboxAuthoritySatisfied(state, await resolveSandboxBindings(state))
    }
    if (!settled) {
      log.warn("sandbox still holds a superseded credential set after reconcile", {
        workspaceId: state.ws.id,
      })
    }
    state.used_at = now()
    scheduleStop(state)
    // The ensure's own push only runs when the digest moved; a revocation that
    // changed only the projection — a reason string, an account that never
    // delivered — still has to reach the runtime.
    await pushRuntimeConfig(state)
  } catch (error) {
    // The mutation stands in the registry either way; this sandbox keeps its
    // last installed set until the next mutation or ensure reconciles it.
    log.warn("sandbox credential delivery reconcile failed", {
      workspaceId: state.ws.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export function listSupervisorSandboxs() {
  return [...runtimes.values()]
    .filter((item) => item.url && item.status === "ready")
    .map((item) => ({
      workspaceId: item.ws.id,
      directory: item.ws.directory,
      remoteDirectory: runtimeWorkspaceDir(item.ws),
      url: item.url!,
      port: item.port!,
      status: item.status,
      started_at: item.started_at,
      used_at: item.used_at,
      active: item.active,
    }))
}

export function getSupervisorSandboxTarget(workspaceId: string) {
  return runtimes.get(workspaceId)?.sandbox_target
}

export function touchSupervisorSandbox(workspaceId: string) {
  const item = runtimes.get(workspaceId)
  if (!item?.remote) return
  touchSandbox(item).catch(() => {})
}

export function getSupervisorSandboxStatus(workspaceId: string) {
  return runtimes.get(workspaceId)?.status
}

export function markSupervisorSandboxUse(workspaceId: string) {
  const item = runtimes.get(workspaceId)
  if (!item) return
  item.used_at = now()
  scheduleStop(item)
}

export function holdSupervisorSandbox(workspaceId: string) {
  const item = runtimes.get(workspaceId)
  if (!item) return
  item.active += 1
  item.used_at = now()
  clearRuntimeStop(item)

  const hold = acquireSupervisorSandboxHold(workspaceId, "stream", `hold-${item.active}`, "runtime hold")
  item.holds.push(hold.hold_id)
}

export function releaseSupervisorSandbox(workspaceId: string) {
  const item = runtimes.get(workspaceId)
  if (!item) return
  item.active = Math.max(0, item.active - 1)
  item.used_at = now()
  scheduleStop(item)

  const id = item.holds.pop()
  if (id) releaseSupervisorSandboxHold(id)
  cleanExpiredSupervisorSandboxHolds(workspaceId)
}

export async function stopSupervisorSandbox(workspaceId: string, reason = "manual") {
  const item = runtimes.get(workspaceId)
  if (!item) return
  // A start in flight owns this entry and its lease epoch until it settles,
  // and it publishes a url after awaiting a health probe and a config push.
  // Stopping underneath it retires a target the start then advertises anyway,
  // so this queues behind it the way the sandbox manager queues one lifecycle
  // operation behind another.
  if (item.start) await item.start.catch(() => undefined)
  if (item.status === "stopped") return
  const isRemote = item.remote
  const stopped = isRemote ? await stopSandbox(item, reason) : { keepSandbox: false }
  item.status = "stopped"
  clearRuntimeStop(item)
  if (item.health_monitor) {
    clearInterval(item.health_monitor)
    item.health_monitor = undefined
  }
  releaseHolds(item)
  item.url = undefined
  item.port = undefined
  item.start = undefined
  item.sandbox_target = undefined
  const next = await updateWorkspace(item.ws.id, {
    status: "stopped",
  }).catch(() => undefined)
  if (next) item.ws = next

  if (isRemote && !stopped.keepSandbox) {
    item.sandbox_id = undefined
    item.sandbox_target = undefined
  }
  log.info("workspace-runtime stopped", { workspaceId, reason })
}

export async function discardSupervisorSandbox(workspaceId: string, reason = "discarded") {
  const item = runtimes.get(workspaceId)
  if (item) {
    await stopSupervisorSandbox(workspaceId, reason).catch((err) => {
      log.warn("workspace-runtime discard stop failed", {
        workspaceId,
        reason,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    releaseHolds(item)
  }
  runtimes.delete(workspaceId)
  releaseSupervisorSandboxLease(workspaceId)
}

export async function shutdownWorkspaceSupervisor() {
  await Promise.allSettled([...runtimes.keys()].map((id) => stopSupervisorSandbox(id, "shutdown")))
}

export function getSandboxLease(workspaceId: string) {
  return getSupervisorSandboxLease(workspaceId)
}

export function createWorkspaceSupervisorSandboxManager(): SandboxManager {
  return {
    async ensure(workspaceId, input) {
      try {
        const bindings: SandboxBindings = {
          ...(input.secrets !== undefined ? { secrets: input.secrets } : {}),
          ...(input.net !== undefined ? { net: input.net } : {}),
        }
        const entry = input.hostId
          ? await ensureRelayProtectedSandbox(workspaceId, input.hostId, bindings)
          : await ensureSupervisorSandbox(workspaceId, bindings)
        const lease = getSupervisorSandboxLease(workspaceId)
        const target = entry.sandbox_target ?? sandboxTargetFromSupervisorState(entry) ?? sandboxTargetFromLease(lease)
        if (!target) {
          return {
            status: "unavailable",
            error: "runtime_target_missing",
            epoch: lease?.epoch,
            homeRegion: (lease?.home_region ?? input.homeRegion),
          }
        }
        return sandboxReadyResult(target, lease, input.homeRegion)
      } catch (err) {
        const lease = getSupervisorSandboxLease(workspaceId)
        return {
          status: "unavailable",
          retryAfterMs: lease?.next_retry_at ? Math.max(0, lease.next_retry_at - Date.now()) : undefined,
          error: err instanceof Error ? err.message : String(err),
          epoch: lease?.epoch,
          homeRegion: (lease?.home_region ?? input.homeRegion),
        }
      }
    },
    register: recordSupervisorRuntimeSnapshot,
    heartbeat: recordSupervisorRuntimeSnapshot,
    async target(workspaceId) {
      const entry = runtimes.get(workspaceId)
      const lease = getSupervisorSandboxLease(workspaceId)
      const target = entry?.sandbox_target ?? (entry ? sandboxTargetFromSupervisorState(entry) : undefined)
      if (target) return sandboxReadyResult(target, lease, "us-east")
      return sandboxTargetResultFromLease(lease)
    },
    async touch(workspaceId) {
      touchSupervisorSandbox(workspaceId)
      const lease = updateSupervisorSandboxLease(workspaceId, { last_activity_at: Date.now() }) ?? getSupervisorSandboxLease(workspaceId)
      return lease
        ? { touched: true, status: sandboxLeaseStatus(lease.status) }
        : { touched: false, status: "missing" }
    },
    async snapshot() {
      return { ok: false, reason: "snapshot_unsupported" }
    },
    async checkpoint(workspaceId, input) {
      const ws = await getWorkspace(workspaceId)
      if (!ws) throw new Error(`workspace not found: ${workspaceId}`)
      return await captureSupervisorSandboxCheckpoint(runtimeState(ws), input)
    },
    async restore(workspaceId, input) {
      const ws = await getWorkspace(workspaceId)
      if (!ws) throw new Error(`workspace not found: ${workspaceId}`)
      return await restoreSupervisorSandboxCheckpoint(runtimeState(ws), input)
    },
    async stop(workspaceId) {
      const observed = getSupervisorSandboxLease(workspaceId)
      await stopSupervisorSandbox(workspaceId, "sandbox_manager_stop")
      return { ok: true, status: await recordSupervisorSandboxLeaseStopped(observed) }
    },
    async destroy(workspaceId) {
      await discardSupervisorSandbox(workspaceId, "sandbox_manager_destroy")
      return { ok: true, status: "destroyed" }
    },
    async release(workspaceId) {
      return { released: releaseSupervisorSandboxLease(workspaceId) }
    },
    // The local supervisor has no provider to enumerate: every sandbox it knows
    // about is a lease in its own state, so "provider state the lease table has
    // no record of" is not a representable condition here. It reports
    // `listingUnsupported` for the same reason the Cloudflare driver does — not
    // because listing failed, but because there is nothing independent to list,
    // so `kept` below is a lease inventory and not evidence that nothing is
    // orphaned. Without this flag the four arrays read as a clean sweep, which
    // is the silent success this exists to remove.
    async garbageCollect() {
      return {
        destroyed: [],
        kept: listSupervisorSandboxLeases().flatMap((lease) => {
          const target = sandboxTargetFromLease(lease)
          return target ? [target] : []
        }),
        skipped: [],
        failed: [],
        listingUnsupported: true as const,
        driver: "workspace-supervisor",
      }
    },
    async list() {
      return listSupervisorSandboxLeases().map(sandboxLeaseFromRow)
    },
  }
}

export function injectRuntime(ws: Workspace, url: string) {
  const state: WorkspaceRuntimeState = {
    ws,
    url,
    port: parseInt(new URL(url).port, 10),
    status: "ready",
    started_at: now(),
    used_at: now(),
    crashes: 0,
    retry_at: 0,
    active: 0,
    holds: [],
    remote: true,
    sandbox_target: {
      // The workspace row's `sandbox_id` column is not the runtime host
      // location authority (that lives on the lease, e.g. sandboxTargetFromLease).
      // `injectRuntime` is a direct-injection seam given the runtime URL outright,
      // so the workspace id is the synthetic host identity here.
      sandboxId: ws.id,
      url,
      hostId: ws.id,
      driver: ws.driver
        ? {
          id: ws.driver,
          resourceId: ws.id,
        }
        : undefined,
    },
  }
  runtimes.set(ws.id, state)
  return state
}

function sandboxReadyResult(
  target: SandboxTarget,
  lease: SandboxLeaseRow | undefined,
  fallbackHomeRegion: SandboxLease["homeRegion"],
): SandboxEnsureResult & SandboxTargetResult {
  return {
    status: "ready",
    ...target,
    epoch: lease?.epoch ?? 0,
    homeRegion: (lease?.home_region ?? fallbackHomeRegion),
  }
}

function sandboxTargetResultFromLease(lease: SandboxLeaseRow | undefined): SandboxTargetResult {
  const target = sandboxTargetFromLease(lease)
  if (!lease) return { status: "unavailable", reason: "runtime_lease_missing" }
  if (!target || lease.status !== "ready") {
    return {
      status: "unavailable",
      reason: "runtime_lease_not_ready",
      leaseStatus: sandboxLeaseStatus(lease.status),
      ...(lease.next_retry_at != null ? { retryAfterMs: Math.max(0, lease.next_retry_at - Date.now()) } : {}),
    }
  }
  return sandboxReadyResult(target, lease, "us-east")
}

/**
 * Record a stop against the lease the stop observed.
 *
 * `stopSandbox` stops through the canonical manager, which records the stop
 * itself on the epoch it stopped; this covers the paths that return before
 * reaching it — a local workspace, no driver, no recorded sandbox — and a
 * repeat stop, which writes nothing and still succeeds. Fenced on that
 * observed epoch and status so a replacement provisioned while the driver
 * call ran keeps its own status, and carrying no identity so the new epoch's
 * target survives a stop aimed at the old one.
 */
async function recordSupervisorSandboxLeaseStopped(
  observed: SandboxLeaseRow | undefined,
): Promise<SandboxLease["status"]> {
  if (!observed) return "stopped"
  const status = sandboxLeaseStatus(observed.status)
  if (status === "stopped" || status === "destroyed") return status
  const store = createSupervisorSandboxLeaseStore()
  const stopped = await store.update(observed.workspace_id, observed.epoch, { status: "stopped" }, status)
  if (stopped) return stopped.status
  return (await store.get(observed.workspace_id))?.status ?? "stopped"
}

function sandboxTargetFromSupervisorState(state: WorkspaceRuntimeState): SandboxTarget | undefined {
  if (!state.url || !state.sandbox_id) return undefined
  const lease = getSupervisorSandboxLease(state.ws.id)
  const hostId = state.relay_host_id ?? lease?.lease_id ?? state.sandbox_id
  const driverResourceId = lease?.driver_resource_id ?? state.sandbox_id
  return {
    workspaceId: state.ws.id,
    sandboxId: state.sandbox_id,
    url: state.url,
    hostId,
    driverResourceId,
    driver: state.ws.driver
      ? {
        id: state.ws.driver,
        resourceId: driverResourceId,
      }
      : undefined,
  }
}

async function startRuntime(state: WorkspaceRuntimeState, stated?: SandboxBindings) {
  if (state.ws.kind !== "cloud") {
    // Only a stated SECRET has to reach a driver. Every hosted connection route
    // states an egress policy, so reading "the caller stated something" here
    // sent a warm local runtime back through a path that has no driver at all
    // and answered the operator "unavailable".
    if (state.status === "ready" && state.url && stated?.secrets === undefined) {
      state.used_at = now()
      scheduleStop(state)
      return state
    }
    throw new Error("local workspaces use embedded workspace-runtime hosts")
  }
  const authority = await resolveSandboxBindings(state, stated)
  // A warm runtime is served from memory only while it already holds the
  // authority this ensure demands. Answering on the presence of an account
  // rather than on a change to it sends every message through the driver, which
  // on a replacement-host driver is a new sandbox per message.
  if (state.status === "ready" && state.url && sandboxAuthoritySatisfied(state, authority)) {
    state.used_at = now()
    scheduleStop(state)
    return state
  }
  if (state.start) return state.start
  state.start = (async () => {
    try {
      return await startSandbox(state, { scheduleStop }, authority)
    } finally {
      state.start = undefined
    }
  })()
  return state.start
}

function scheduleStop(state: WorkspaceRuntimeState) {
  clearRuntimeStop(state)
  state.stop = setTimeout(() => {
    void (async () => {
      if (state.active > 0 || now() - state.used_at < IDLE_MS || await runtimeHasActiveWork(state)) {
        scheduleStop(state)
        return
      }
      await stopSupervisorSandbox(state.ws.id, "idle").catch((error) => {
        log.warn("workspace-runtime idle checkpoint failed", {
          workspaceId: state.ws.id,
          error: error instanceof Error ? error.message : String(error),
        })
        if (state.status === "ready") scheduleStop(state)
      })
    })()
  }, IDLE_MS)
}

function releaseHolds(state: WorkspaceRuntimeState) {
  for (const id of state.holds.splice(0)) {
    releaseSupervisorSandboxHold(id)
  }
  state.active = 0
}
