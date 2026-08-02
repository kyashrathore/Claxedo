import { randomUUID } from "crypto"
import { type RuntimeConfigSnapshot, loadUserConfig, sandboxDriverConfig } from "../../agent-config"
import {
  createSandboxManager,
  type SandboxBootSource,
  type SandboxCheckpointRuntime,
  type SandboxEnsureResult,
  type SandboxManager,
} from "@claxedo/sandbox-manager"
import { createBoxSandboxDriver } from "@claxedo/sandbox-manager/drivers/box"
import { createCloudflareSandboxDriver } from "@claxedo/sandbox-manager/drivers/cloudflare"
import { createDaytonaSandboxDriver } from "@claxedo/sandbox-manager/drivers/daytona"
import { createDockerSandboxDriver } from "@claxedo/sandbox-manager/drivers/docker"
import { createModalSandboxDriver } from "@claxedo/sandbox-manager/drivers/modal"
import { createVercelSandboxDriver } from "@claxedo/sandbox-manager/drivers/vercel"
import { WORKSPACE_DIR } from "@claxedo/sandbox-manager/defaults"
import { SNAPSHOT_NAME } from "@claxedo/sandbox-manager/image"
import type { SandboxLeaseRow } from "@claxedo/sandbox-manager/lease-types"
import {
  decideSandboxHealthFailure,
  decideSandboxStart,
  sandboxDriverPlacement,
  type SandboxDecision,
  type SandboxDriverPlacement,
} from "@claxedo/sandbox-manager/lease-policy"
import { emitProvision } from "../../sandbox-manager-adapters/provision-events"
import { sandboxDriverAuthAsync } from "../../sandbox-manager-adapters/driver-auth"
import { defaultSandboxDriverID } from "@claxedo/sandbox-manager/driver-catalog"
import type { SandboxDriverID } from "@claxedo/sandbox-manager/driver-catalog"
import { Log } from "../../lib/log"
import { defaultHomeRegion } from "../../region"
import { listPolicies } from "../../network/policy"
import { resolveSandboxNetworkPolicy } from "../../network/resolve"
import { insertSnapshot } from "../../storage/prepared-image.sql"
import { updateWorkspace } from "../store/store"
import {
  configToken,
  configTokenHeaders,
  stateConfigToken,
  supervisorBackplaneHeaders,
} from "./control-token"
import { pushRuntimeConfig } from "./config-sync"
import {
  createSupervisorSandboxLeaseStore,
  getSupervisorSandboxLease,
  markSupervisorSandboxLeaseFailed,
  pendingSandboxLease,
  recordSupervisorSandboxLeaseReady,
  recordSupervisorSandboxStartFailure,
  updateSupervisorSandboxLease,
  sandboxLeaseUrl,
} from "../../sandbox-manager-adapters/stores/sqlite-supervisor-state"
import { needWorkspaceSupervisorOptions } from "./options"
import {
  controlPlaneVerificationEnv,
  relayHostVerificationEnv,
  runtimeDirectAuthEnv,
  sandboxLeaseEnv,
  sandboxControlPlaneUrl,
} from "./runtime-env"
import { now, runtimeBackoffMs, sleep } from "./clock"
import type { WorkspaceRuntimeState } from "./store"

const log = Log.create({ service: "workspace-supervisor" })

type SandboxCallbacks = {
  scheduleStop(state: WorkspaceRuntimeState): void
}

export async function startSandbox(
  state: WorkspaceRuntimeState,
  callbacks: SandboxCallbacks,
): Promise<WorkspaceRuntimeState> {
  const cfg = await loadUserConfig()
  const driverId =
    state.ws.driver ??
    needWorkspaceSupervisorOptions().default_sandbox_driver ??
    defaultSandboxDriverID(sandboxDriverConfig(cfg))
  const placement = sandboxDriverPlacement(driverId)
  const storedLease = getSupervisorSandboxLease(state.ws.id)
  const prev = storedLease ?? pendingSandboxLease(state.ws.id, driverId, now())
  const recordedHostUrl = storedLease?.status === "ready" ? sandboxLeaseUrl(storedLease) : undefined

  if (recordedHostUrl) {
    const attached = await attachRecordedSandbox(state, callbacks, {
      driverId,
      storedLease,
      hostUrl: recordedHostUrl,
    })
    if (attached) return attached
  }

  const action = sandboxStartAction(state, prev, placement)

  if (action.action === "wait") {
    const ms = Math.max(0, action.until - now())
    if (ms > 0) await sleep(ms)
    return startSandbox(state, callbacks)
  }

  if (action.action === "mark_failed") {
    markSupervisorSandboxLeaseFailed(state.ws.id, action.reason)
    throw new Error(action.reason)
  }

  log.info("Sandbox bootstrap start", {
    workspaceId: state.ws.id,
    driver: driverId,
    action: action.action,
    reason: action.reason,
    status: prev.status,
    hasSandboxId: !!prev.sandbox_id,
    remoteDirectory: state.ws.remote_directory || WORKSPACE_DIR,
    hasRepoUrl: !!state.ws.repo_url,
  })

  state.status = "starting"
  state.used_at = now()

  try {
    await markSandboxAcquiring(state)
    const net = await resolveSupervisorSandboxNetworkPolicy(state, driverId, action)
    const result = await (
      await createSupervisorSandboxManager(state, driverId)
    ).ensure(state.ws.id, {
      // Was hardcoded "us-east" (W6b.3). This is the sole non-test producer of a
      // workspace's home region, and the relay now derives its Durable Object
      // location hint from that region — a hint fixed at first DO creation and
      // never migrated. So a hardcoded "us-east" would permanently pin every
      // workspace's relay to eastern North America regardless of where its users
      // are. `defaultHomeRegion()` reads CLAXEDO_HOME_REGION and validates it
      // against the deployment's own region set (`region/index.ts`).
      homeRegion: defaultHomeRegion(),
      labels: {
        projectId: state.ws.project_id ?? "",
      },
      bootSource: bootSourceForAction(action),
      workspaceRoot: state.ws.remote_directory || WORKSPACE_DIR,
      env: {},
      source: state.ws.repo_url
        ? { kind: "git", repoUrl: state.ws.repo_url, branch: state.ws.git_branch ?? undefined }
        : { kind: "empty" },
      net: net ? { mode: net.mode, hosts: net.hosts, cidrs: net.cidrs } : undefined,
    })
    if (result.status === "provisioning") {
      await sleep(result.retryAfterMs)
      return startSandbox(state, callbacks)
    }
    if (result.status !== "ready") {
      throw new Error(result.error ?? "sandbox unavailable")
    }
    return await markSandboxReady(state, callbacks, result)
  } catch (err) {
    state.url = undefined
    state.crashes += 1
    state.retry_at = now() + runtimeBackoffMs(state.crashes)
    state.status = "backoff"
    const message = err instanceof Error ? err.message : String(err)

    recordSupervisorSandboxStartFailure(state.ws.id, message)
    emitProvision(state.ws, "error", { message })
    log.warn("Sandbox start failed", {
      workspaceId: state.ws.id,
      driver: driverId,
      sandboxId: state.sandbox_id,
      action: action.action,
      error: message,
    })
    throw err
  }
}

export async function stopSandbox(state: WorkspaceRuntimeState, reason: string) {
  if (!state.remote) return { keepSandbox: false }
  const driverId = sandboxDriverId(state)
  if (!driverId) return { keepSandbox: false }
  const lease = getSupervisorSandboxLease(state.ws.id)
  if (!state.sandbox_target && !lease?.sandbox_id) {
    return { keepSandbox: false }
  }
  const keepSandbox = sandboxDriverPlacement(driverId).canPauseAndRestartSameResource
  const manager = await createSupervisorSandboxManager(state, driverId)
  const canonical = lease?.status === "ready"
    && lease.persistence
    && lease.persistence.capture !== "none"
    && lease.checkpoint?.sourceEpoch !== lease.epoch
    ? await manager.checkpoint(state.ws.id, {
        runtime: checkpointRuntime(state),
        policy: reason === "idle" || reason === "shutdown" ? "interrupt" : "drain",
      })
    : undefined
  const snapshot = canonical || lease?.checkpoint?.sourceEpoch === lease?.epoch
    ? { ok: false as const, reason: "canonical_checkpoint_current" }
    : await manager.snapshot(state.ws.id).catch((err) => ({
        ok: false as const,
        reason: err instanceof Error ? err.message : String(err),
      }))
  if (snapshot.ok) {
    const lease = updateSupervisorSandboxLease(state.ws.id, {
      accel_snapshot_id: snapshot.snapshotId,
      driver_snapshot_id: snapshot.snapshotId,
    })
    insertSnapshot({
      id: randomUUID(),
      workspace_id: state.ws.id,
      runtime_snapshot_id: snapshot.snapshotId,
      driver_snapshot_id: snapshot.snapshotId,
      base_prepared_image_id: lease?.accel_prepared_image_id ?? lease?.accel_base_image_id ?? null,
      source_sha: null,
      reason,
      size_bytes: null,
      status: "ready",
      created_at: now(),
    })
  }
  const stopped = await manager.stop(state.ws.id).catch((err) => ({
    ok: false as const,
    reason: err instanceof Error ? err.message : String(err),
  }))
  if (!stopped.ok) {
    log.warn("Failed to stop sandbox through manager", {
      workspaceId: state.ws.id,
      driver: driverId,
      reason: stopped.reason,
    })
  }
  if (!keepSandbox) {
    updateSupervisorSandboxLease(state.ws.id, {
      sandbox_id: null,
      driver_resource_id: null,
    })
  }
  return { keepSandbox }
}

function checkpointRuntime(state: WorkspaceRuntimeState): SandboxCheckpointRuntime {
  const request = async (path: string, body?: unknown) => {
    if (!state.url) throw new Error("workspace_checkpoint_target_missing")
    const response = await fetch(`${state.url}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...configTokenHeaders(stateConfigToken(state)),
        ...await supervisorBackplaneHeaders(state),
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(45_000),
    })
    if (response.ok) return
    throw new Error(await response.text() || `workspace checkpoint request failed: ${response.status}`)
  }
  return {
    freeze: async (policy) => await request("/api/wr/checkpoint/freeze", { policy }),
    flush: async () => await request("/api/wr/checkpoint/flush"),
    scrub: async () => await request("/api/wr/checkpoint/scrub"),
    resume: async () => await request("/api/wr/checkpoint/resume"),
    reconcile: async (body) => await request("/api/wr/checkpoint/restore-reconcile", body),
  }
}

export async function touchSandbox(state: WorkspaceRuntimeState) {
  if (!state.remote) return
  const driverId = sandboxDriverId(state)
  if (!driverId) return
  await (await createSupervisorSandboxManager(state, driverId)).touch(state.ws.id)
}

async function attachRecordedSandbox(
  state: WorkspaceRuntimeState,
  callbacks: SandboxCallbacks,
  input: {
    driverId: SandboxDriverID
    storedLease: SandboxLeaseRow | undefined
    hostUrl: string
  },
) {
  try {
    configToken(state)
    await waitForRuntimeHealth(input.hostUrl)
    state.url = input.hostUrl
    state.remote = true
    state.status = "ready"
    state.started_at = now()
    state.crashes = 0
    state.retry_at = 0
    const sandboxId = input.storedLease?.sandbox_id ?? input.storedLease?.driver_resource_id ?? undefined
    if (sandboxId) {
      state.sandbox_id = sandboxId
      state.sandbox_target = sandboxTarget(
        input.driverId,
        sandboxId,
        input.hostUrl,
        input.storedLease?.lease_id || sandboxId,
        input.storedLease?.driver_resource_id ?? sandboxId,
      )
    }
    await pushRuntimeConfig(state)
    recordSupervisorSandboxLeaseReady({
    workspaceId: state.ws.id,
    driver: input.driverId,
    sandboxId,
    url: input.hostUrl,
    hostId: input.storedLease?.lease_id,
    driverResourceId: input.storedLease?.driver_resource_id ?? sandboxId,
  })
    const ws = await updateWorkspace(state.ws.id, {
      status: "ready",
    })
    if (ws) state.ws = ws
    callbacks.scheduleStop(state)
    startSandboxHealthMonitor(state)
    log.info("sandbox attached to recorded url", {
      workspaceId: state.ws.id,
      driver: input.driverId,
      url: state.url,
    })
    return state
  } catch (err) {
    log.warn("Recorded sandbox url is not healthy; provisioning host", {
      workspaceId: state.ws.id,
      driver: input.driverId,
      url: input.hostUrl,
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

function sandboxStartAction(
  state: WorkspaceRuntimeState,
  prev: SandboxLeaseRow,
  placement: SandboxDriverPlacement,
): SandboxDecision {
  const action =
    prev.status === "ready" && prev.sandbox_id && placement.canPauseAndRestartSameResource
      ? ({ action: "resume", reason: `resume sandbox ${prev.sandbox_id}` } as const)
      : decideSandboxStart(prev, placement, now())

  if (action.action !== "skip" || state.status === "ready") return action
  return prev.sandbox_id && placement.canPauseAndRestartSameResource
    ? { action: "resume", reason: `resume sandbox ${prev.sandbox_id}` }
    : { action: "start_fresh", reason: `reconcile ${prev.status} lease` }
}

async function resolveSupervisorSandboxNetworkPolicy(
  state: WorkspaceRuntimeState,
  driverId: SandboxDriverID,
  action: SandboxDecision,
) {
  const rows = listPolicies(state.ws.id)
  const net =
    driverId === "docker"
      ? undefined
      : rows.length > 0
        ? await resolveSandboxNetworkPolicy(
            rows.map((e) => ({ target: e.target, kind: e.kind })),
            needWorkspaceSupervisorOptions().server_url,
          )
        : undefined
  log.info("Sandbox network policy resolved", {
    workspaceId: state.ws.id,
    driver: driverId,
    action: action.action,
    policyCount: rows.length,
    netMode: net?.mode ?? (driverId === "docker" ? `skipped-${driverId}` : "allow-all"),
  })
  return net
}

async function markSandboxAcquiring(state: WorkspaceRuntimeState) {
  emitProvision(state.ws, "acquiring_sandbox")
  const pending = await updateWorkspace(state.ws.id, {
    status: "acquiring_sandbox",
  })
  if (pending) state.ws = pending
}

async function createSupervisorSandboxManager(state: WorkspaceRuntimeState, driverId: SandboxDriverID) {
  const driver = await sandboxDriverForSupervisor(state, driverId)
  return createSandboxManager({
    leaseStore: createSupervisorSandboxLeaseStore(),
    driver,
    retryDelayMs: (retryCount) => runtimeBackoffMs(retryCount),
  })
}

export async function captureSupervisorSandboxCheckpoint(
  state: WorkspaceRuntimeState,
  input: Parameters<SandboxManager["checkpoint"]>[1],
) {
  const driverId = sandboxDriverId(state)
  if (!driverId) throw new Error("workspace_checkpoint_driver_missing")
  return await (await createSupervisorSandboxManager(state, driverId)).checkpoint(state.ws.id, input)
}

export async function restoreSupervisorSandboxCheckpoint(
  state: WorkspaceRuntimeState,
  input: Parameters<SandboxManager["restore"]>[1],
) {
  const driverId = sandboxDriverId(state)
  if (!driverId) throw new Error("workspace_restore_driver_missing")
  return await (await createSupervisorSandboxManager(state, driverId)).restore(state.ws.id, input)
}

async function sandboxDriverForSupervisor(state: WorkspaceRuntimeState, driverId: SandboxDriverID) {
  const cfg = sandboxDriverConfig(await loadUserConfig())
  if (driverId === "daytona") {
    const auth = await sandboxDriverAuthAsync(cfg, "daytona")
    if (auth?.api_key) {
      return createDaytonaSandboxDriver({
        apiKey: auth.api_key,
        baseSnapshot:
          clean(process.env.CLAXEDO_DAYTONA_SNAPSHOT) ?? SNAPSHOT_NAME,
        ...(clean(process.env.DAYTONA_API_URL) ? { apiUrl: clean(process.env.DAYTONA_API_URL) } : {}),
        ...(clean(process.env.DAYTONA_ORGANIZATION_ID)
          ? { organizationId: clean(process.env.DAYTONA_ORGANIZATION_ID) }
          : {}),
        ...(clean(process.env.DAYTONA_TARGET) ? { target: clean(process.env.DAYTONA_TARGET) } : {}),
        ...(clean(process.env.CLAXEDO_RUNTIME_COMMAND)
          ? { runtimeCommand: clean(process.env.CLAXEDO_RUNTIME_COMMAND) }
          : {}),
        ...(clean(process.env.CLAXEDO_RUNTIME_RUNNER) ? { runner: clean(process.env.CLAXEDO_RUNTIME_RUNNER) } : {}),
        env: (_input, sandbox) => runtimeEnvForHost(state, driverId, sandbox.id),
      })
    }
    throw missingSandboxDriverAuth(driverId, "api_key")
  }

  if (driverId === "cloudflare") {
    const auth = await sandboxDriverAuthAsync(cfg, "cloudflare")
    if (auth?.api_token && auth.worker_url) {
      return createCloudflareSandboxDriver({
        workerUrl: auth.worker_url,
        apiToken: auth.api_token,
        ...(clean(process.env.CLAXEDO_RUNTIME_COMMAND)
          ? { runtimeCommand: clean(process.env.CLAXEDO_RUNTIME_COMMAND) }
          : {}),
        ...(clean(process.env.CLAXEDO_RUNTIME_RUNNER) ? { runner: clean(process.env.CLAXEDO_RUNTIME_RUNNER) } : {}),
        env: (_input, sandbox) => runtimeEnvForHost(state, driverId, sandbox.id),
      })
    }
    throw missingSandboxDriverAuth(driverId, "api_token and worker_url")
  }

  if (driverId === "modal") {
    const auth = await sandboxDriverAuthAsync(cfg, "modal")
    if (auth?.token_id && auth.token_secret) {
      return createModalSandboxDriver({
        tokenId: auth.token_id,
        tokenSecret: auth.token_secret,
        ...(clean(process.env.CLAXEDO_MODAL_APP_NAME) ? { appName: clean(process.env.CLAXEDO_MODAL_APP_NAME) } : {}),
        ...(clean(process.env.CLAXEDO_RUNTIME_IMAGE) ? { baseImage: clean(process.env.CLAXEDO_RUNTIME_IMAGE) } : {}),
        ...(clean(process.env.CLAXEDO_RUNTIME_COMMAND)
          ? { runtimeCommand: clean(process.env.CLAXEDO_RUNTIME_COMMAND) }
          : {}),
        ...(clean(process.env.CLAXEDO_RUNTIME_RUNNER) ? { runner: clean(process.env.CLAXEDO_RUNTIME_RUNNER) } : {}),
        env: (_input, host) => runtimeEnvForHost(state, driverId, host.id),
      })
    }
    throw missingSandboxDriverAuth(driverId, "token_id and token_secret")
  }

  if (driverId === "vercel") {
    const auth = await sandboxDriverAuthAsync(cfg, "vercel")
    if (auth?.access_token && auth.team_id && auth.project_id) {
      return createVercelSandboxDriver({
        token: auth.access_token,
        teamId: auth.team_id,
        projectId: auth.project_id,
        ...(clean(process.env.CLAXEDO_VERCEL_SNAPSHOT_ID)
          ? { baseSnapshotId: clean(process.env.CLAXEDO_VERCEL_SNAPSHOT_ID) }
          : {}),
        ...(clean(process.env.CLAXEDO_RUNTIME_COMMAND)
          ? { runtimeCommand: clean(process.env.CLAXEDO_RUNTIME_COMMAND) }
          : {}),
        ...(clean(process.env.CLAXEDO_RUNTIME_RUNNER) ? { runner: clean(process.env.CLAXEDO_RUNTIME_RUNNER) } : {}),
        env: (_input, host) => runtimeEnvForHost(state, driverId, host.id),
      })
    }
    throw missingSandboxDriverAuth(driverId, "access_token, team_id, and project_id")
  }

  if (driverId === "box") {
    const auth = await sandboxDriverAuthAsync(cfg, "box")
    if (auth?.api_key) {
      return createBoxSandboxDriver({
        apiKey: auth.api_key,
        ...(clean(process.env.CLAXEDO_BOX_API_URL) ? { baseUrl: clean(process.env.CLAXEDO_BOX_API_URL) } : {}),
        ...(clean(process.env.CLAXEDO_RUNTIME_IMAGE) ? { image: clean(process.env.CLAXEDO_RUNTIME_IMAGE) } : {}),
        ...(clean(process.env.CLAXEDO_RUNTIME_COMMAND)
          ? { runtimeCommand: clean(process.env.CLAXEDO_RUNTIME_COMMAND) }
          : {}),
        ...(clean(process.env.CLAXEDO_RUNTIME_RUNNER) ? { runner: clean(process.env.CLAXEDO_RUNTIME_RUNNER) } : {}),
        env: (_input, host) => runtimeEnvForHost(state, driverId, host.id),
      })
    }
    throw missingSandboxDriverAuth(driverId, "api_key")
  }

  if (driverId === "docker") {
    const auth = await sandboxDriverAuthAsync(cfg, "docker")
    if (auth?.image) {
      return createDockerSandboxDriver({
        image: auth.image,
        ...(clean(process.env.CLAXEDO_RUNTIME_COMMAND)
          ? { runtimeCommand: clean(process.env.CLAXEDO_RUNTIME_COMMAND) }
          : {}),
        ...(clean(process.env.CLAXEDO_RUNTIME_RUNNER) ? { runner: clean(process.env.CLAXEDO_RUNTIME_RUNNER) } : {}),
        env: (_input, host) => runtimeEnvForHost(state, driverId, host.id),
      })
    }
    throw missingSandboxDriverAuth(driverId, "image")
  }

  throw new Error(`Unsupported sandbox driver: ${driverId}`)
}

function sandboxDriverId(state: WorkspaceRuntimeState): SandboxDriverID | undefined {
  return (
    (state.sandbox_target?.driver?.id as SandboxDriverID | undefined) ??
    state.ws.driver ??
    getSupervisorSandboxLease(state.ws.id)?.driver
  )
}

function runtimeEnvForHost(state: WorkspaceRuntimeState, driverId: SandboxDriverID, sandboxId: string) {
  const options = needWorkspaceSupervisorOptions()
  const controlPlaneUrl = sandboxControlPlaneUrl(driverId, options.server_url)
  const lease = getSupervisorSandboxLease(state.ws.id)
  return {
    ...controlPlaneVerificationEnv(driverId, controlPlaneUrl, { options }),
    ...relayHostVerificationEnv(driverId, { options }),
    ...runtimeDirectAuthEnv(configToken(state)),
    WORKSPACE_RUNTIME_DISABLE_CORS: "1",
    // Encode the host's opencode-compat decision onto the process-boundary
    // wire: runtime-boot.ts decodes this into the opencodeCompat option. The
    // kit itself never reads ambient env — this is the ONLY writer.
    ...(process.env.CLAXEDO_DISABLE_OPENCODE_COMPAT === "1"
      ? { WORKSPACE_RUNTIME_OPENCODE_COMPAT: "0" }
      : {}),
    ...(lease
      ? sandboxLeaseEnv({
          leaseId: lease.lease_id,
          epoch: lease.epoch,
          sandboxId,
        })
      : {}),
  }
}

function missingSandboxDriverAuth(driverId: SandboxDriverID, fields: string) {
  return new Error(`Sandbox driver ${driverId} is not configured; missing ${fields}`)
}

function clean(input: string | undefined) {
  const value = input?.trim()
  return value ? value : undefined
}

function bootSourceForAction(action: SandboxDecision): SandboxBootSource {
  if (action.action === "restore_snapshot") return { kind: "driver-snapshot", snapshotId: action.snapshot_id }
  if (action.action === "start_prepared") return { kind: "image", image: action.image_id }
  return { kind: "default" }
}

async function markSandboxReady(
  state: WorkspaceRuntimeState,
  callbacks: SandboxCallbacks,
  target: Extract<SandboxEnsureResult, { status: "ready" }>,
) {
  state.status = "ready"
  state.remote = true
  state.started_at = now()
  state.crashes = 0
  state.retry_at = 0
  state.url = target.url
  state.sandbox_id = target.sandboxId
  state.sandbox_target = target

  await pushRuntimeConfig(state)

  const ws = await updateWorkspace(state.ws.id, {
    status: "ready",
  })
  if (ws) state.ws = ws

  callbacks.scheduleStop(state)
  startSandboxHealthMonitor(state)
  emitProvision(state.ws, "ready")

  log.info("sandbox ready", {
    workspaceId: state.ws.id,
    sandboxId: target.sandboxId,
    url: state.url,
  })
  return state
}

function sandboxTarget(
  driverId: SandboxDriverID,
  sandboxId: string,
  url: string,
  hostId = sandboxId,
  driverResourceId = sandboxId,
) {
  return {
    sandboxId,
    url,
    hostId,
    driverResourceId,
    driver: {
      id: driverId,
      resourceId: driverResourceId,
    },
  }
}

function startSandboxHealthMonitor(state: WorkspaceRuntimeState) {
  if (state.health_monitor) clearInterval(state.health_monitor)
  state.health_monitor = setInterval(async () => {
    if (state.status !== "ready") return
    try {
      const res = await fetch(`${state.url}/global/health`, {
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) {
        touchSandbox(state).catch(() => {})
        updateSupervisorSandboxLease(state.ws.id, { last_activity_at: now() })
        return
      }
    } catch {}
    log.warn("Sandbox health check failed", { workspaceId: state.ws.id })
    state.crashes += 1
    state.status = "backoff"
    state.retry_at = now() + runtimeBackoffMs(state.crashes)
    clearInterval(state.health_monitor)
    state.health_monitor = undefined

    const lease = getSupervisorSandboxLease(state.ws.id)
    if (!lease) return
    const action = decideSandboxHealthFailure(lease, sandboxDriverPlacement(lease.driver), now())

    if (action.action === "mark_failed") {
      markSupervisorSandboxLeaseFailed(state.ws.id, action.reason)
      return
    }

    const run = recordSupervisorSandboxStartFailure(state.ws.id, "workspace health check failed")
    if (run.ok) {
      state.retry_at = run.lease.next_retry_at ?? state.retry_at
    }
  }, 15_000)
}

async function waitForRuntimeHealth(url: string) {
  const until = now() + 20_000
  let err = "workspace runtime not ready"
  while (now() < until) {
    try {
      const res = await fetch(`${url}/global/health`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (res.ok) return
      err = `${res.status} ${res.statusText}`
    } catch (cause) {
      err = cause instanceof Error ? cause.message : String(cause)
    }
    await sleep(250)
  }
  throw new Error(err)
}
