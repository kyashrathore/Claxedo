import { Daytona, type Sandbox, SandboxState } from "@daytonaio/sdk"
import { Log } from "../../log"
import { formatDaytonaAllowList, type SandboxNetworkPolicy } from "../../network/resolve"
import { createCloudflareSandbox, CloudflareSandboxHandle } from "./cloudflare"
import { wrapDaytona } from "./daytona"
import { ensureSnapshot } from "./image"
import { createModalSandbox } from "./modal"
import { createVercelSandbox } from "./vercel"
import type { SandboxConfig } from "../types"
import { SandboxProvider, type SandboxAcquireInput, type SandboxAttachInput } from "./provider"

const log = Log.create({ service: "sandbox" })

const APP = "claxedo"
const POOL_TARGET = 1
const WARM_AUTOSTOP_MIN = 30
const MONITOR_MS = 60_000
const DAYTONA_MS = 60_000

type DaytonaAuth = {
  api_key: string
}

type ModalAuth = {
  token_id: string
  token_secret: string
}

type VercelAuth = {
  access_token: string
  team_id?: string
  project_id?: string
}

type CloudflareAuth = {
  api_token: string
  worker_url: string
}

function clean(input: string | undefined) {
  const txt = input?.trim()
  return txt ? txt : undefined
}

function json(secret: string) {
  try {
    return JSON.parse(secret) as Record<string, unknown>
  } catch {
    return
  }
}

function vercel(input: {
  access_token?: string
  team_id?: string
  project_id?: string
}): VercelAuth | undefined {
  const access_token = clean(input.access_token)
  if (!access_token) return
  return {
    access_token,
    ...(clean(input.team_id) ? { team_id: clean(input.team_id) } : {}),
    ...(clean(input.project_id) ? { project_id: clean(input.project_id) } : {}),
  }
}

async function within<T>(label: string, ms: number, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      run(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export class DaytonaProvider extends SandboxProvider<DaytonaAuth> {
  private client: Daytona | undefined
  private key: string | undefined
  private snap: string | undefined
  private monitor: ReturnType<typeof setInterval> | undefined

  constructor() {
    super(
      "daytona",
      "Daytona",
      [{ key: "api_key", label: "API Key", secret: true }],
      {
        attach: true,
        labels: true,
        net: "cidr",
        pool: true,
        restart: true,
      },
    )
  }

  protected sync(cfg?: SandboxConfig) {
    const api_key = clean(cfg?.auth?.daytona?.api_key) ?? clean(process.env.DAYTONA_API_KEY)
    return api_key ? { api_key } : undefined
  }

  protected parse(secret: string) {
    return clean(secret) ? { api_key: secret.trim() } : undefined
  }

  async poolEnabled(cfg?: SandboxConfig) {
    return !!(await this.auth(cfg))?.api_key
  }

  async acquire(input: SandboxAcquireInput) {
    const daytona = await this.daytona(input.cfg)
    const locked = input.net?.mode === "restricted"

    if (!locked) {
      const hit = await within("daytona warm lookup", DAYTONA_MS, () => this.warm(daytona))
      if (hit) {
        await within("daytona relabel warm sandbox", DAYTONA_MS, () =>
          hit.setLabels({
            app: APP,
            pool: "assigned",
            workspace_id: input.workspaceId,
            project_id: input.projectId,
          }),
        )
        log.info("Acquired warm sandbox", { sandboxId: hit.id, workspaceId: input.workspaceId })
        this.refill(input.cfg).catch(() => {})
        return wrapDaytona(daytona, hit)
      }
    }

    const snap = await within("daytona snapshot lookup", DAYTONA_MS, () => this.snapshot(daytona))
    const sandbox = await within("daytona create sandbox", DAYTONA_MS, () =>
      daytona.create({
        snapshot: snap,
        labels: {
          app: APP,
          pool: "assigned",
          workspace_id: input.workspaceId,
          project_id: input.projectId,
        },
        ...(locked
          ? {
              networkBlockAll: true,
              ...(input.net?.cidrs.length ? { networkAllowList: formatDaytonaAllowList(input.net.cidrs) } : {}),
            }
          : {}),
      }),
    )
    this.refill(input.cfg).catch(() => {})
    return wrapDaytona(daytona, sandbox)
  }

  async acquireFromSnapshot(input: SandboxAcquireInput & { snapshotId: string }) {
    const daytona = await this.daytona(input.cfg)
    const sandbox = await within("daytona create sandbox from snapshot", DAYTONA_MS, () =>
      daytona.create({
        snapshot: input.snapshotId,
        labels: {
          app: APP,
          pool: "assigned",
          workspace_id: input.workspaceId,
          project_id: input.projectId,
        },
        ...(input.net?.mode === "restricted"
          ? {
              networkBlockAll: true,
              ...(input.net.cidrs.length ? { networkAllowList: formatDaytonaAllowList(input.net.cidrs) } : {}),
            }
          : {}),
      }),
    )
    return wrapDaytona(daytona, sandbox)
  }

  async acquireFromImage(input: SandboxAcquireInput & { imageId: string }) {
    const daytona = await this.daytona(input.cfg)
    const sandbox = await within("daytona create sandbox from image", DAYTONA_MS, () =>
      daytona.create({
        image: input.imageId,
        labels: {
          app: APP,
          pool: "assigned",
          workspace_id: input.workspaceId,
          project_id: input.projectId,
        },
        ...(input.net?.mode === "restricted"
          ? {
              networkBlockAll: true,
              ...(input.net.cidrs.length ? { networkAllowList: formatDaytonaAllowList(input.net.cidrs) } : {}),
            }
          : {}),
      }),
    )
    return wrapDaytona(daytona, sandbox)
  }

  async attach(input: SandboxAttachInput) {
    const daytona = await this.daytona(input.cfg)
    return wrapDaytona(daytona, await within("daytona attach sandbox", DAYTONA_MS, () => daytona.get(input.sandboxId)))
  }

  async initPool(cfg?: SandboxConfig) {
    if (!await this.poolEnabled(cfg)) {
      log.debug("Skipping Daytona pool initialization: credentials not configured")
      return
    }
    await this.reconcile(cfg)
  }

  startPoolMonitor() {
    if (this.monitor) return
    this.monitor = setInterval(() => {
      this.reconcile().catch((err) => {
        log.warn("Daytona pool reconcile failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }, MONITOR_MS)
  }

  shutdown() {
    if (!this.monitor) return
    clearInterval(this.monitor)
    this.monitor = undefined
  }

  released() {
    this.refill().catch(() => {})
  }

  private async daytona(cfg?: SandboxConfig) {
    const auth = await this.auth(cfg)
    if (!auth?.api_key) throw new Error("Missing Daytona API key")
    if (this.client && this.key === auth.api_key) return this.client
    this.key = auth.api_key
    this.snap = undefined
    this.client = new Daytona({ apiKey: auth.api_key })
    return this.client
  }

  private labels() {
    return { app: APP, pool: "warm", snapshot: this.snap || "" }
  }

  private async snapshot(daytona: Daytona) {
    if (!this.snap) {
      this.snap = await ensureSnapshot(daytona)
    }
    return this.snap
  }

  private async warm(daytona: Daytona) {
    const result = await within("daytona list warm sandboxes", DAYTONA_MS, () => daytona.list(this.labels()))
    return result.items.find((item) => item.state === SandboxState.STARTED)
  }

  private async createWarm(daytona: Daytona): Promise<Sandbox> {
    const snapshot = await within("daytona warm snapshot lookup", DAYTONA_MS, () => this.snapshot(daytona))
    const sandbox = await within("daytona create warm sandbox", DAYTONA_MS, () =>
      daytona.create({
        snapshot,
        labels: this.labels(),
        autoStopInterval: WARM_AUTOSTOP_MIN,
      }),
    )
    log.info("Created warm sandbox", { sandboxId: sandbox.id })
    return sandbox
  }

  private async refill(cfg?: SandboxConfig) {
    const daytona = await this.daytona(cfg)
    const result = await within("daytona refill list", DAYTONA_MS, () => daytona.list(this.labels()))
    const ready = result.items.filter((item) => item.state === SandboxState.STARTED)
    const miss = POOL_TARGET - ready.length
    if (miss <= 0) return
    await Promise.allSettled(Array.from({ length: miss }, () => this.createWarm(daytona)))
  }

  private async reconcile(cfg?: SandboxConfig) {
    const daytona = await this.daytona(cfg)
    const result = await within("daytona reconcile list", DAYTONA_MS, () => daytona.list(this.labels()))
    for (const item of result.items) {
      if (item.state === SandboxState.STARTED) continue
      await within("daytona prune warm sandbox", DAYTONA_MS, () => daytona.delete(item)).catch((err) => {
        log.warn("Failed to prune warm sandbox", {
          sandboxId: item.id,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
    const ready = result.items.filter((item) => item.state === SandboxState.STARTED)
    for (const item of ready.slice(POOL_TARGET)) {
      await within("daytona prune excess warm sandbox", DAYTONA_MS, () => daytona.delete(item)).catch((err) => {
        log.warn("Failed to prune excess warm sandbox", {
          sandboxId: item.id,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
    await this.refill(cfg)
  }
}

export class ModalProvider extends SandboxProvider<ModalAuth> {
  constructor() {
    super(
      "modal",
      "Modal",
      [
        { key: "token_id", label: "Token ID", secret: true },
        { key: "token_secret", label: "Token Secret", secret: true },
      ],
      {
        attach: false,
        labels: true,
        net: "cidr",
        pool: false,
        restart: false,
      },
    )
  }

  protected sync(cfg?: SandboxConfig) {
    const token_id = clean(cfg?.auth?.modal?.token_id) ?? clean(process.env.MODAL_TOKEN_ID)
    const token_secret = clean(cfg?.auth?.modal?.token_secret) ?? clean(process.env.MODAL_TOKEN_SECRET)
    return token_id && token_secret ? { token_id, token_secret } : undefined
  }

  protected parse(secret: string) {
    const parsed = json(secret)
    if (typeof parsed?.token_id !== "string" || typeof parsed?.token_secret !== "string") return
    return {
      token_id: parsed.token_id,
      token_secret: parsed.token_secret,
    }
  }

  async acquire(input: SandboxAcquireInput) {
    const auth = await this.auth(input.cfg)
    if (!auth) throw new Error("Missing Modal token_id or token_secret")
    return createModalSandbox({
      tokenId: auth.token_id,
      tokenSecret: auth.token_secret,
      name: `claxedo-${input.workspaceId}`,
      net: input.net,
    })
  }

  async acquireFromImage(input: SandboxAcquireInput & { imageId: string }) {
    const auth = await this.auth(input.cfg)
    if (!auth) throw new Error("Missing Modal token_id or token_secret")
    return createModalSandbox({
      tokenId: auth.token_id,
      tokenSecret: auth.token_secret,
      name: `claxedo-${input.workspaceId}`,
      net: input.net,
      imageId: input.imageId,
    })
  }
}

export class VercelProvider extends SandboxProvider<VercelAuth> {
  constructor() {
    super(
      "vercel",
      "Vercel",
      [
        { key: "access_token", label: "Access Token", secret: true },
        { key: "team_id", label: "Team ID" },
        { key: "project_id", label: "Project ID" },
      ],
      {
        attach: false,
        labels: false,
        net: "mixed",
        pool: false,
        restart: false,
      },
    )
  }

  protected sync(cfg?: SandboxConfig) {
    return vercel({
      access_token: cfg?.auth?.vercel?.access_token ?? process.env.VERCEL_TOKEN,
      team_id: cfg?.auth?.vercel?.team_id ?? process.env.VERCEL_TEAM_ID,
      project_id: cfg?.auth?.vercel?.project_id ?? process.env.VERCEL_PROJECT_ID,
    })
  }

  protected parse(secret: string) {
    const parsed = json(secret)
    if (!parsed) return vercel({ access_token: secret })
    if (typeof parsed.access_token !== "string") return
    return vercel({
      access_token: parsed.access_token,
      team_id: typeof parsed.team_id === "string" ? parsed.team_id : undefined,
      project_id: typeof parsed.project_id === "string" ? parsed.project_id : undefined,
    })
  }

  async acquire(input: SandboxAcquireInput) {
    const auth = await this.auth(input.cfg)
    if (!auth) throw new Error("Missing Vercel access token")
    return createVercelSandbox({
      token: auth.access_token,
      teamId: auth.team_id,
      projectId: auth.project_id,
      net: input.net,
    })
  }

  async acquireFromSnapshot(input: SandboxAcquireInput & { snapshotId: string }) {
    const auth = await this.auth(input.cfg)
    if (!auth) throw new Error("Missing Vercel access token")
    return createVercelSandbox({
      token: auth.access_token,
      teamId: auth.team_id,
      projectId: auth.project_id,
      net: input.net,
      snapshotId: input.snapshotId,
    })
  }
}

export class CloudflareProvider extends SandboxProvider<CloudflareAuth> {
  constructor() {
    super(
      "cloudflare",
      "Cloudflare (experimental)",
      [
        { key: "api_token", label: "API Token", secret: true },
        { key: "worker_url", label: "Worker URL" },
      ],
      {
        attach: true,
        labels: false,
        net: "host",
        pool: false,
        restart: true,
      },
    )
  }

  protected sync(cfg?: SandboxConfig) {
    const api_token = clean(cfg?.auth?.cloudflare?.api_token) ?? clean(process.env.CLOUDFLARE_API_TOKEN)
    const worker_url = clean(cfg?.auth?.cloudflare?.worker_url) ?? clean(process.env.CLOUDFLARE_SANDBOX_WORKER_URL)
    return api_token && worker_url ? { api_token, worker_url } : undefined
  }

  protected parse(secret: string) {
    const parsed = json(secret)
    if (typeof parsed?.api_token !== "string" || typeof parsed?.worker_url !== "string") return
    return {
      api_token: parsed.api_token,
      worker_url: parsed.worker_url,
    }
  }

  async acquire(input: SandboxAcquireInput) {
    const auth = await this.auth(input.cfg)
    if (!auth) throw new Error("Missing Cloudflare API token or Worker URL")
    return createCloudflareSandbox({
      sandboxId: `claxedo-${input.workspaceId}`,
      workerUrl: auth.worker_url,
      apiToken: auth.api_token,
      net: input.net,
    })
  }

  async acquireFromSnapshot(input: SandboxAcquireInput & { snapshotId: string }) {
    const auth = await this.auth(input.cfg)
    if (!auth) throw new Error("Missing Cloudflare API token or Worker URL")
    const sandbox = await createCloudflareSandbox({
      sandboxId: `claxedo-${input.workspaceId}`,
      workerUrl: auth.worker_url,
      apiToken: auth.api_token,
      net: input.net,
    })
    await sandbox.restoreBackup?.({ id: input.snapshotId })
    return sandbox
  }

  async attach(input: SandboxAttachInput) {
    const auth = await this.auth(input.cfg)
    if (!auth) return
    return new CloudflareSandboxHandle(input.sandboxId, auth.worker_url, auth.api_token)
  }
}
