import { Daytona, Sandbox, SandboxState } from "@daytonaio/sdk"
import { Log } from "../log"
import { ensureSnapshot } from "./sandbox-image"
import { defaultSandboxProvider, sandboxAuth } from "./provider"
import { loadUserConfig } from "../agent-config"

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
  return !!sandboxAuth(cfg.sandbox, "daytona")?.api_key
}

async function getDaytona(): Promise<Daytona> {
  if (client) return client
  const cfg = await loadUserConfig()
  const auth = sandboxAuth(cfg.sandbox, "daytona")
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

export async function acquire(workspaceId: string, projectId: string): Promise<Sandbox> {
  const daytona = await getDaytona()
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
    return ready
  }

  log.warn("Warm pool exhausted, cold-starting sandbox", { workspaceId })
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
  })
  replenish().catch(() => {})
  return sandbox
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
