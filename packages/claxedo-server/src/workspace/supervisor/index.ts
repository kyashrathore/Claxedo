import type { AgentExtensionPolicyOverride } from "../../hosts/agent-extensions/runtime-config"
import type { WorkspaceAgentExtensionRecord } from "../../hosts/agent-extensions/workspace"
import { Log } from "../../platform/runtime/lib/log"
import { updateWorkspace, getWorkspace, type Workspace } from "../store"
import { createClaxedoRuntimeConfig } from "../../hosts/workspace-runtime/runtime-config"
import { IDLE_MS, now } from "./clock"
import {
  pushRuntimeConfig,
  runtimeConfigSnapshot,
  runtimeHasActiveWork,
} from "./config-sync"
import {
  captureSupervisorSandboxCheckpoint,
  restoreSupervisorSandboxCheckpoint,
  startSandbox,
  stopSandbox,
  touchSandbox,
} from "./sandbox"
import {
  acquireSupervisorSandboxHold,
  cleanExpiredSupervisorSandboxHolds,
  getSupervisorSandboxLease,
  listSupervisorSandboxLeases,
  recordSupervisorSandboxLeaseReady,
  releaseSupervisorSandboxHold,
  releaseSupervisorSandboxLease,
  updateSupervisorSandboxLease,
  sandboxLeaseFromRow,
  sandboxLeaseStatus,
  sandboxLeaseUrl,
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
  SandboxRegisterInput,
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
}

export async function ensureSupervisorSandbox(workspaceId: string) {
  const ws = await getWorkspace(workspaceId)
  if (!ws) throw new Error(`workspace not found: ${workspaceId}`)
  const entry = await startRuntime(runtimeState(ws))
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
) {
  if (!hostId.trim()) throw new Error("host id required")
  const ws = await getWorkspace(workspaceId)
  if (!ws) throw new Error(`workspace not found: ${workspaceId}`)
  const entry = runtimeState(ws)
  if (entry.relay_host_id && entry.relay_host_id !== hostId) {
    throw new Error(`sandbox mismatch: ${workspaceId}`)
  }
  entry.relay_host_id = hostId
  const started = await startRuntime(entry)
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

export async function syncWorkspaceRuntimeAgentExtensions(
  workspaceId: string,
  installs: WorkspaceAgentExtensionRecord[],
  options: {
    policyOverrides?: AgentExtensionPolicyOverride[]
  } = {},
) {
  const entry = runtimes.get(workspaceId)
  if (!entry || entry.status !== "ready" || !entry.url) return
  try {
    await pushRuntimeConfig(entry, await createClaxedoRuntimeConfig({
      workspaceDir: runtimeWorkspaceDir(entry.ws),
      workspaceId,
      workspaceInstalls: installs,
      ...(options.policyOverrides ? { policyOverrides: options.policyOverrides } : {}),
    }))
  } catch (err) {
    log.warn("Failed to push agent-extensions snapshot to workspace runtime", {
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function broadcastRuntimeConfig() {
  const cfg = await runtimeConfigSnapshot()
  await Promise.allSettled(
    [...runtimes.values()]
      .filter((item) => item.status === "ready" && item.url)
      .map((item) => pushRuntimeConfig(item, cfg)),
  )
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

export function listSandboxLeases() {
  return listSupervisorSandboxLeases()
}

export function createWorkspaceSupervisorSandboxManager(): SandboxManager {
  return {
    async ensure(workspaceId, input) {
      try {
        const entry = input.hostId
          ? await ensureRelayProtectedSandbox(workspaceId, input.hostId)
          : await ensureSupervisorSandbox(workspaceId)
        const lease = getSupervisorSandboxLease(workspaceId)
        const target = entry.sandbox_target ?? sandboxTargetFromSupervisorState(entry) ?? sandboxTargetFromLease(lease)
        if (!target) {
          return {
            status: "unavailable",
            error: "runtime_target_missing",
            epoch: lease?.epoch,
            homeRegion: (lease?.home_region ?? input.homeRegion) as SandboxLease["homeRegion"],
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
          homeRegion: (lease?.home_region ?? input.homeRegion) as SandboxLease["homeRegion"],
        }
      }
    },
    async register(workspaceId, input) {
      return recordSupervisorRuntimeSnapshot(workspaceId, input)
    },
    async heartbeat(workspaceId, input) {
      return recordSupervisorRuntimeSnapshot(workspaceId, input)
    },
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
      await stopSupervisorSandbox(workspaceId, "sandbox_manager_stop")
      const lease = updateSupervisorSandboxLease(workspaceId, { status: "stopped" })
      return { ok: true, status: sandboxLeaseStatus(lease?.status ?? "stopped") }
    },
    async destroy(workspaceId) {
      await discardSupervisorSandbox(workspaceId, "sandbox_manager_destroy")
      return { ok: true, status: "destroyed" }
    },
    async release(workspaceId) {
      return { released: releaseSupervisorSandboxLease(workspaceId) }
    },
    // The local supervisor has no provider to enumerate: every sandbox it knows
    // about IS a lease in its own state, so "provider state the lease table has
    // no record of" is not a representable condition here. It reports
    // `listingUnsupported` for the same reason the Cloudflare driver does — not
    // because listing failed, but because there is nothing independent to list,
    // so `kept` below is a lease inventory and NOT evidence that nothing is
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
      // The workspace row's `sandbox_id` column is NOT the runtime host
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
    homeRegion: (lease?.home_region ?? fallbackHomeRegion) as SandboxLease["homeRegion"],
  }
}

function sandboxTargetResultFromLease(lease: SandboxLeaseRow | undefined): SandboxTargetResult {
  const target = sandboxTargetFromLease(lease)
  if (!lease) return { status: "unavailable", reason: "runtime_lease_missing" }
  if (!target || lease.status !== "ready") return { status: "unavailable", reason: "runtime_lease_not_ready" }
  return sandboxReadyResult(target, lease, "us-east")
}

function sandboxTargetFromSupervisorState(state: WorkspaceRuntimeState): SandboxTarget | undefined {
  if (!state.url || !state.sandbox_id) return
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

function recordSupervisorRuntimeSnapshot(workspaceId: string, input: SandboxRegisterInput) {
  const lease = getSupervisorSandboxLease(workspaceId)
  if (!lease) return { ok: false as const, reason: "runtime_lease_missing" }
  const epoch = input.epoch ?? lease.epoch
  if (lease.epoch !== epoch) return { ok: false as const, reason: "runtime_lease_epoch_mismatch" }
  const timestamp = input.now ?? Date.now()
  if (!input.ok || input.status === "unhealthy") {
    updateSupervisorSandboxLease(workspaceId, {
      status: "unhealthy",
      last_heartbeat_at: timestamp,
      last_health_failure_at: timestamp,
      last_error: input.status ?? "runtime_unhealthy",
    })
    return { ok: true as const, status: "unavailable" as const }
  }
  const url = input.url ?? sandboxLeaseUrl(lease)
  if (!url) return { ok: false as const, reason: "host_url_missing" }
  recordSupervisorSandboxLeaseReady({
    workspaceId,
    driver: lease.driver,
    sandboxId: input.sandboxId ?? lease.sandbox_id,
    url,
    hostId: input.hostId ?? lease.lease_id,
    driverResourceId: input.driverResourceId ?? lease.driver_resource_id,
  })
  if (input.active) updateSupervisorSandboxLease(workspaceId, { last_activity_at: timestamp })
  return { ok: true as const, status: "ready" as const }
}

async function startRuntime(state: WorkspaceRuntimeState) {
  if (state.status === "ready" && state.url) {
    state.used_at = now()
    scheduleStop(state)
    return state
  }
  if (state.start) return state.start
  state.start = (async () => {
    try {
      if (state.ws.kind === "cloud") {
        return await startSandbox(state, { scheduleStop })
      }
      throw new Error("local workspaces use embedded workspace-runtime hosts")
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
