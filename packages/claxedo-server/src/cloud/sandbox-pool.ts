import { Daytona, Sandbox, SandboxState } from "@daytonaio/sdk"
import { Log } from "../log"
import { ensureSnapshot } from "./sandbox-image"
import { defaultSandboxProvider, sandboxAuth, sandboxAuthAsync } from "./provider"
import { loadUserConfig } from "../agent-config"
import { formatDaytonaAllowList, type SandboxNetworkPolicy } from "../network/resolve"
import type { SandboxHandle } from "./sandbox-handle"
import type { SandboxProviderID } from "./types"
import { DaytonaSandboxHandle } from "./sandbox-daytona"
import { createVercelSandbox } from "./sandbox-vercel"
import { createCloudflareSandbox } from "./sandbox-cloudflare"
import { createModalSandbox } from "./sandbox-modal"

const log = Log.create({ service: "sandbox-pool" })

const POOL_TARGET = Number(process.env.CLAXEDO_POOL_SIZE || "3")
const WARM_AUTOSTOP_MIN = 30
const MONITOR_INTERVAL_MS = 60_000

let client: Daytona | undefined
let snapshotName: string | undefined
let monitor: ReturnType<typeof setInterval> | undefined

const APP_LABEL = "claxedo"

export async function poolEnabled(): Promise<boolean> {
  const cfg = await loadUserConfig()
  if (defaultSandboxProvider(cfg.sandbox) !== "daytona") return false
  const auth = await sandboxAuthAsync(cfg.sandbox, "daytona") ?? sandboxAuth(cfg.sandbox, "daytona")
  return !!auth?.api_key
}

async function getDaytona(): Promise<Daytona> {
  if (client) return client
  const cfg = await loadUserConfig()
  const auth = await sandboxAuthAsync(cfg.sandbox, "daytona") ?? sandboxAuth(cfg.sandbox, "daytona")
  if (!auth?.api_key) throw new Error("Missing Daytona API key for sandbox pool")
  client = new Daytona({ apiKey: auth.api_key })
  return client
}

function warmLabels(): Record<string, string> {
  return { app: APP_LABEL, pool: "warm", snapshot: snapshotName || "" }
}

async function createWarm(): Promise<Sandbox> {
  const daytona = await getDaytona()
  if (!snapshotName) {
    snapshotName = await ensureSnapshot(daytona)
  }
  const sandbox = await daytona.create({
    snapshot: snapshotName,
    labels: warmLabels(),
    autoStopInterval: WARM_AUTOSTOP_MIN,
  })
  log.info("Created warm sandbox", { sandboxId: sandbox.id })
  return sandbox
}

async function replenish(): Promise<void> {
  try {
    const daytona = await getDaytona()
    const result = await daytona.list(warmLabels())
    const started = result.items.filter((s) => s.state === SandboxState.STARTED)
    const deficit = POOL_TARGET - started.length
    if (deficit <= 0) return

    log.info("Replenishing warm pool", { deficit, current: started.length, target: POOL_TARGET })
    await Promise.allSettled(
      Array.from({ length: deficit }, () =>
        createWarm().catch((err) => {
          log.warn("Failed to create warm sandbox", {
            error: err instanceof Error ? err.message : String(err),
          })
        }),
      ),
    )
  } catch (err) {
    log.warn("Pool replenish failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function acquireDaytona(
  workspaceId: string,
  projectId: string,
  net?: SandboxNetworkPolicy,
): Promise<SandboxHandle> {
  const daytona = await getDaytona()
  const locked = net?.mode === "restricted"

  // If a network policy is configured, skip the warm pool and cold-start
  // with restrictions — warm sandboxes don't have network restrictions
  // because they need connectivity for deploy/clone.
  if (!locked) {
    const result = await daytona.list(warmLabels())
    const ready = result.items.find((s) => s.state === SandboxState.STARTED)

    if (ready) {
      await ready.setLabels({
        app: APP_LABEL,
        pool: "assigned",
        workspace_id: workspaceId,
        project_id: projectId,
      })
      log.info("Acquired warm sandbox", { sandboxId: ready.id, workspaceId })
      replenish().catch(() => {})
      return new DaytonaSandboxHandle(ready)
    }
  }

  log.info(
    locked
      ? "Cold-starting sandbox with network policy"
      : "Warm pool exhausted, cold-starting sandbox",
    { workspaceId, networkCidrs: net?.cidrs.length ?? 0, networkHosts: net?.hosts.length ?? 0 },
  )
  if (!snapshotName) {
    snapshotName = await ensureSnapshot(daytona)
  }
  const sandbox = await daytona.create({
    snapshot: snapshotName,
    labels: {
      app: APP_LABEL,
      pool: "assigned",
      workspace_id: workspaceId,
      project_id: projectId,
    },
    ...(locked
      ? {
          networkBlockAll: true,
          ...(net.cidrs.length ? { networkAllowList: formatDaytonaAllowList(net.cidrs) } : {}),
        }
      : {}),
  })
  replenish().catch(() => {})
  return new DaytonaSandboxHandle(sandbox)
}

async function acquireVercel(workspaceId: string, net?: SandboxNetworkPolicy): Promise<SandboxHandle> {
  const cfg = await loadUserConfig()
  const auth = await sandboxAuthAsync(cfg.sandbox, "vercel") ?? sandboxAuth(cfg.sandbox, "vercel")
  if (!auth?.access_token) throw new Error("Missing Vercel access token")

  // @vercel/sandbox reads VERCEL_TOKEN from env for auth
  const prevToken = process.env.VERCEL_TOKEN
  process.env.VERCEL_TOKEN = auth.access_token
  try {
    const handle = await createVercelSandbox({ net })
    log.info("Acquired Vercel sandbox", { sandboxId: handle.id, workspaceId })
    return handle
  } finally {
    if (prevToken !== undefined) process.env.VERCEL_TOKEN = prevToken
    else delete process.env.VERCEL_TOKEN
  }
}

async function acquireCloudflare(workspaceId: string, net?: SandboxNetworkPolicy): Promise<SandboxHandle> {
  const cfg = await loadUserConfig()
  const auth = await sandboxAuthAsync(cfg.sandbox, "cloudflare") ?? sandboxAuth(cfg.sandbox, "cloudflare")
  if (!auth?.api_token || !auth.worker_url) {
    throw new Error("Missing Cloudflare API token or Worker URL")
  }

  const sandboxId = `claxedo-${workspaceId}`
  const handle = await createCloudflareSandbox({
    sandboxId,
    workerUrl: auth.worker_url,
    apiToken: auth.api_token,
    net,
  })
  log.info("Acquired Cloudflare sandbox", { sandboxId: handle.id, workspaceId })
  return handle
}

async function acquireModal(workspaceId: string, net?: SandboxNetworkPolicy): Promise<SandboxHandle> {
  const cfg = await loadUserConfig()
  const auth = await sandboxAuthAsync(cfg.sandbox, "modal") ?? sandboxAuth(cfg.sandbox, "modal")
  if (!auth?.token_id || !auth.token_secret) {
    throw new Error("Missing Modal token_id or token_secret")
  }

  const handle = await createModalSandbox({
    tokenId: auth.token_id,
    tokenSecret: auth.token_secret,
    name: `claxedo-${workspaceId}`,
    net,
  })
  log.info("Acquired Modal sandbox", { sandboxId: handle.id, workspaceId })
  return handle
}

/**
 * Acquire a sandbox from the configured provider.
 *
 * - Daytona: pulls from a warm pool or cold-starts with snapshot
 * - Modal: creates via the official `modal` SDK
 * - Vercel: creates a fresh microVM (millisecond startup)
 * - Cloudflare: lazy-starts via Worker proxy (container starts on first operation)
 */
export async function acquire(
  workspaceId: string,
  projectId: string,
  net?: SandboxNetworkPolicy,
  provider?: SandboxProviderID,
): Promise<SandboxHandle> {
  const cfg = await loadUserConfig()
  const id = provider ?? defaultSandboxProvider(cfg.sandbox)

  switch (id) {
    case "daytona":
      return acquireDaytona(workspaceId, projectId, net)
    case "modal":
      return acquireModal(workspaceId, net)
    case "vercel":
      return acquireVercel(workspaceId, net)
    case "cloudflare":
      return acquireCloudflare(workspaceId, net)
  }
}

export async function release(sandboxId: string): Promise<void> {
  try {
    const daytona = await getDaytona()
    const sandbox = await daytona.get(sandboxId)
    await daytona.delete(sandbox)
    log.info("Released sandbox", { sandboxId })
  } catch (err) {
    log.warn("Failed to release sandbox", {
      sandboxId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  replenish().catch(() => {})
}

async function reconcile(): Promise<void> {
  try {
    const daytona = await getDaytona()
    const result = await daytona.list(warmLabels())

    for (const s of result.items) {
      if (s.state !== SandboxState.STARTED) {
        log.info("Pruning non-started warm sandbox", { sandboxId: s.id, state: s.state })
        await daytona.delete(s).catch((err) => {
          log.warn("Failed to prune sandbox", {
            sandboxId: s.id,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      }
    }

    await replenish()
  } catch (err) {
    log.warn("Pool reconcile failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function initPool(): Promise<void> {
  if (!await poolEnabled()) {
    log.debug("Skipping sandbox pool initialization: Daytona auth not configured")
    return
  }
  try {
    const daytona = await getDaytona()
    snapshotName = await ensureSnapshot(daytona)
    await replenish()
    log.info("Sandbox pool initialized", { target: POOL_TARGET, snapshot: snapshotName })
  } catch (err) {
    log.warn("Pool initialization failed (will retry on demand)", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startPoolMonitor(): void {
  if (monitor) return
  monitor = setInterval(() => {
    reconcile().catch(() => {})
  }, MONITOR_INTERVAL_MS)
}

export function shutdown(): void {
  if (monitor) {
    clearInterval(monitor)
    monitor = undefined
  }
}
