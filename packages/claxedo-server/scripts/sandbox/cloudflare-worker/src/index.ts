/**
 * Cloudflare Worker that proxies sandbox operations over HTTP.
 *
 * Deploy: cd cloudflare-worker && npm install && wrangler deploy
 * Set secret: wrangler secret put API_TOKEN
 */
import { WorkerEntrypoint } from "cloudflare:workers"
import type { DurableObjectState, Request as WorkerRequest, Response as WorkerResponse } from "@cloudflare/workers-types"
import {
  getSandbox,
  Sandbox as CloudflareSandbox,
  type SandboxOperations,
  type SandboxProcess,
} from "@cloudflare/sandbox"
import { RUNTIME_PREPARATION_DEADLINE_MS, WORKSPACE_RUNTIME_BOOT_FAILED } from "../../../../src/hosts/workspace-runtime/boot-contract"
import { credentialPlaceholder, forwardCredential, parseRegistrations, type EgressRegistration } from "./outbound-credentials"
import { safeRuntimeLog } from "./runtime-log"
import { asWorkerRecord, stringMap } from "./worker-json"
import { backupIds, captureDirectories, deleteBackups, directoryRestore, uncommittedBackups, type DirectoryBackup } from "./directory-backups"
import { IDLE_CHECK, IDLE_CHECK_FAILURE_LIMIT, IDLE_CHECK_SECONDS, requestIdleStop, workspaceIdlePlacement, type IdleEnv, type WorkspaceIdle } from "./workspace-idle"

/** What a sandbox's credential hosts are intercepted with, from `ctx.exports` (`enable_ctx_exports`). */
export class CredentialEgress extends WorkerEntrypoint<Env, { sandboxId: string }> {
  override async fetch(request: WorkerRequest): Promise<WorkerResponse> {
    // The entrypoint's signature takes workers-types' Request and Response;
    // the broker is written against the DOM lib's. They are one class at runtime.
    const answer = await forwardCredential(request as unknown as Request, {
      registrations: () => readRegistrations(this.env, this.ctx.props.sandboxId),
    })
    return answer as unknown as WorkerResponse
  }
}

const CREDENTIAL_HOSTS_KEY = "claxedo.credential-hosts"
const RUNTIME_READY_KEY = "claxedo.runtime-ready"
const WORKSPACE_IDLE_KEY = "claxedo.workspace-idle"
const PENDING_BACKUPS_KEY = "claxedo.pending-backups"
// Rebuildable state under HOME that would lengthen every capture's freeze.
const HOME_CACHE_EXCLUDES = [".cache", ".npm/_cacache", ".bun/install/cache"]
// The SDK refuses to restore a backup past its TTL. A checkpoint's backups are
// deleted when a newer checkpoint commits or the workspace is destroyed, so the
// TTL only has to outlive the longest a workspace may sleep.
const BACKUP_TTL_SECONDS = 10 * 365 * 24 * 60 * 60
// The platform mints the CA the container trusts with its first HTTPS
// interception, and `interceptHttps` makes the container refuse to start
// without that CA. A reserved name no request resolves mints it for a sandbox
// that starts before it holds any credential host, so a host registered later
// is intercepted without restarting the container and nothing else is.
const TRUST_ANCHOR_HOST = "claxedo-credential-trust.invalid"

type CredentialHosts = { sandboxId: string; hosts: string[] }

// Local export is required for Wrangler's [[containers]].class_name binding to
// attach this Worker's Dockerfile to the Durable Object class. The process
// operations `this` is passed to live on the ambient `@cloudflare/sandbox`
// declaration, so no call site re-asserts `this`.
export class Sandbox extends CloudflareSandbox {
  interceptHttps = true

  private workspaceRuntimeEnsure?: Promise<RuntimeEnsure>
  private readonly workerEnv: Env

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.workerEnv = env
    // An interception belongs to the running container, and the platform
    // offers no removal, so only a restarted object re-installs it.
    void ctx.blockConcurrencyWhile(async () => {
      if (ctx.container?.running) await this.interceptCredentialHosts()
    })
  }

  /** Intercepts exactly the hosts a registration names; every other host keeps its direct route. */
  async setCredentialHosts(sandboxId: string, hosts: readonly string[]) {
    await this.ctx.storage.put(CREDENTIAL_HOSTS_KEY, { sandboxId, hosts: [...new Set(hosts)] } satisfies CredentialHosts)
    if (this.ctx.container?.running) await this.interceptCredentialHosts()
  }

  async start(...args: unknown[]) {
    if (!this.ctx.container?.running) await this.interceptCredentialHosts()
    return super.start(...args)
  }

  async startAndWaitForPorts(...args: unknown[]) {
    if (!this.ctx.container?.running) await this.interceptCredentialHosts()
    return super.startAndWaitForPorts(...args)
  }

  private async interceptCredentialHosts() {
    const container = this.ctx.container
    if (!container) return
    const recorded = await this.ctx.storage.get<CredentialHosts>(CREDENTIAL_HOSTS_KEY)
    const egress = this.ctx.exports.CredentialEgress({ props: { sandboxId: recorded?.sandboxId ?? "" } })
    for (const host of [TRUST_ANCHOR_HOST, ...recorded?.hosts ?? []]) await container.interceptOutboundHttps(host, egress)
  }

  /**
   * `reuseRunning: false` is how a caller says the boot env changed. A running
   * process keeps the environment it was spawned with, so a credential
   * registered after boot never becomes its placeholder env var until the
   * process itself is replaced.
   */
  ensureWorkspaceRuntime(command: string, env: Record<string, string>, port: number, options: { reuseRunning: boolean; restore?: DirectoryBackup[] }) {
    if (this.workspaceRuntimeEnsure) return this.workspaceRuntimeEnsure
    const operation = (async () => {
      if (options.restore) {
        // Restoring over an active writer is unsafe: stop the runtime, mount
        // every captured directory, then boot against the restored state.
        await stopRuntimeProcess(this, await runtimeProcess(this))
        for (const backup of options.restore) await this.restoreBackup(backup)
      }
      return await ensureRuntimeProcess(this, command, env, port, options)
    })()
    this.workspaceRuntimeEnsure = operation
    return operation.finally(() => {
      if (this.workspaceRuntimeEnsure === operation) this.workspaceRuntimeEnsure = undefined
    })
  }

  async workspaceRuntimeReady(port: number) {
    const process = await runtimeProcess(this)
    return Boolean(process && await runtimeReady(process, port, 2_000))
  }

  /** Records this lease generation's idle lifecycle; the health token is the runtime's config token, kept across boots. */
  async configureWorkspaceIdle(placement: Omit<WorkspaceIdle, "healthToken">) {
    const previous = await this.ctx.storage.get<WorkspaceIdle>(WORKSPACE_IDLE_KEY)
    const idle = { ...placement, healthToken: previous?.healthToken ?? `${crypto.randomUUID()}${crypto.randomUUID()}` }
    await this.ctx.storage.put(WORKSPACE_IDLE_KEY, idle)
    return idle.healthToken
  }

  /**
   * A container stopped by the SDK's request-inactivity sleep loses the state
   * outside its backups, and an open browser stream keeps it awake forever.
   * The container is kept alive instead and stops only through a checkpoint,
   * once the runtime itself reports no work for the idle window.
   */
  async watchWorkspaceIdle() {
    await this.setKeepAlive(true)
    this.deleteSchedules(IDLE_CHECK)
    await this.schedule(IDLE_CHECK_SECONDS, IDLE_CHECK)
  }

  /** Once the control plane has stopped the lease, this object stops its own container rather than waiting to be told. */
  async checkWorkspaceIdle() {
    const idle = await this.ctx.storage.get<WorkspaceIdle>(WORKSPACE_IDLE_KEY)
    if (!idle || !this.ctx.container?.running) return
    try {
      const health = await this.containerFetch(new Request("http://runtime/api/wr/health", {
        headers: { authorization: `Bearer ${idle.healthToken}` },
      }), idle.port)
      const stopped = await requestIdleStop(idle, health, this.workerEnv)
      if (stopped) {
        await this.stopWorkspace(idle.epoch, stopped.checkpoint)
        return
      }
      if (idle.failures) await this.ctx.storage.put(WORKSPACE_IDLE_KEY, { ...idle, failures: 0 })
    } catch (error) {
      const failures = (idle.failures ?? 0) + 1
      console.error("workspace idle stop failed", { workspaceId: idle.workspaceId, epoch: idle.epoch, failures, error: String(error) })
      await this.ctx.storage.put(WORKSPACE_IDLE_KEY, { ...idle, failures })
      if (failures >= IDLE_CHECK_FAILURE_LIMIT) {
        await this.setKeepAlive(false)
        return
      }
    }
    await this.schedule(IDLE_CHECK_SECONDS, IDLE_CHECK)
  }

  /**
   * Stops the container for lease generation `epoch`; a generation that already
   * took the sandbox over keeps it. Backups this object made that the lease did
   * not commit (`committed`) are deleted first.
   */
  async stopWorkspace(epoch: number, committed?: string) {
    const idle = await this.ctx.storage.get<WorkspaceIdle>(WORKSPACE_IDLE_KEY)
    if (idle && idle.epoch !== epoch) return false
    await this.settleBackups(committed)
    this.deleteSchedules(IDLE_CHECK)
    await this.setKeepAlive(false)
    await this.stop()
    return true
  }

  /**
   * Backs up each directory and records every id as soon as it exists, so a
   * capture whose caller gave up is still found: the next capture or stop
   * deletes whatever the lease did not commit.
   */
  async captureBackups(directories: readonly string[], committed: string | undefined) {
    const bucket = this.backupBucket()
    await this.settleBackups(committed)
    const ids: string[] = []
    try {
      for (const dir of directories) {
        const excludes = dir.startsWith("/home/") ? { excludes: HOME_CACHE_EXCLUDES } : {}
        ids.push((await this.createBackup({ dir, ttl: BACKUP_TTL_SECONDS, ...excludes })).id)
        await this.ctx.storage.put(PENDING_BACKUPS_KEY, ids)
      }
    } catch (error) {
      await deleteBackups(bucket, ids)
      await this.ctx.storage.delete(PENDING_BACKUPS_KEY)
      throw error
    }
    return ids.join(",")
  }

  async deleteCheckpointBackups(ids: readonly string[]) {
    await deleteBackups(this.backupBucket(), ids)
    const pending = await this.ctx.storage.get<string[]>(PENDING_BACKUPS_KEY) ?? []
    await this.ctx.storage.put(PENDING_BACKUPS_KEY, pending.filter((id) => !ids.includes(id)))
  }

  private async settleBackups(committed: string | undefined) {
    const pending = await this.ctx.storage.get<string[]>(PENDING_BACKUPS_KEY) ?? []
    if (pending.length === 0) return
    await deleteBackups(this.backupBucket(), uncommittedBackups(pending, committed))
    await this.ctx.storage.delete(PENDING_BACKUPS_KEY)
  }

  private backupBucket() {
    if (!this.workerEnv.BACKUP_BUCKET) throw new Error("backups require the BACKUP_BUCKET binding")
    return this.workerEnv.BACKUP_BUCKET
  }

  async runtimeWasReady(process: SandboxProcess) {
    return await this.ctx.storage.get<number>(RUNTIME_READY_KEY) === process.startTime.getTime()
  }

  async recordRuntimeReady(process: SandboxProcess) {
    await this.ctx.storage.put(RUNTIME_READY_KEY, process.startTime.getTime())
  }
}

// Minimal structural view of the KV binding we use (avoids a hard dependency
// on @cloudflare/workers-types global scope at build time).
interface EgressKV {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

// Minimal structural view of the R2 binding used by the sandbox registry.
// Deliberately not @cloudflare/workers-types — this Worker models its bindings
// structurally (see EgressKV above) to avoid a build-time global-scope dep.
interface RegistryR2Object {
  key: string
  customMetadata?: Record<string, string>
}
interface RegistryR2 {
  put(
    key: string,
    value: string | null,
    options?: { customMetadata?: Record<string, string> },
  ): Promise<unknown>
  delete(key: string): Promise<void>
  list(options?: {
    prefix?: string
    cursor?: string
    limit?: number
    include?: ("customMetadata" | "httpMetadata")[]
  }): Promise<{ objects: RegistryR2Object[]; truncated: boolean; cursor?: string }>
}

interface Env extends IdleEnv {
  Sandbox: any
  API_TOKEN: string
  /** KV namespace holding brokered secrets keyed by sandbox id, out of the container. */
  EGRESS_SECRETS?: EgressKV
  /**
   * R2 bucket backing the sandbox registry (and workspace checkpoints).
   *
   * Cloudflare sandboxes are Durable Objects, and a DO namespace cannot be
   * enumerated: `idFromName` is one-way, so even the account-level REST
   * list-objects endpoint returns opaque hex ids that cannot be mapped back to
   * a sandbox name. Without a registry the control plane's GC sweep is blind —
   * it cannot answer "what is running that shouldn't be?". So this Worker
   * records each sandbox it creates and drops the record on destroy, which is
   * the pattern Cloudflare itself recommends for exactly this reason.
   */
  BACKUP_BUCKET?: RegistryR2
}

// One R2 object per live sandbox, under a prefix so the registry can be listed
// without colliding with the checkpoint backups sharing this bucket.
const REGISTRY_PREFIX = "sandbox-registry/"
const REGISTRY_LIST_PAGE = 1_000

function registryKey(sandboxId: string) {
  return `${REGISTRY_PREFIX}${sandboxId}`
}

/**
 * Record a sandbox in the registry.
 *
 * Labels live in R2 `customMetadata`, NOT the object body, so a listing is one
 * LIST per page rather than one LIST plus N GETs — the registry is read by a
 * sweep, so per-object round-trips are the cost that matters. Only the labels
 * GC actually reads are stored (`app` decides ownership, `workspaceId`/`epoch`
 * decide identity); customMetadata is capped ~2KB, and caller-supplied labels
 * are unbounded, so copying all of them would let one long label make a
 * sandbox unregisterable — and an unregisterable sandbox is an invisible
 * orphan, the exact failure this registry exists to prevent.
 *
 * Best-effort by design: a registry write must never fail `ensure-runtime` and
 * strand a user's workspace. A missed write degrades to the pre-registry
 * behavior (one invisible sandbox) and is reported, not fatal.
 */
async function registerSandbox(env: Env, sandboxId: string, labels: Record<string, string>) {
  if (!env.BACKUP_BUCKET) return
  const customMetadata: Record<string, string> = { sandboxId }
  for (const key of ["app", "workspaceId", "epoch", "homeRegion"]) {
    const value = labels[key]
    if (typeof value === "string" && value.length <= 256) customMetadata[key] = value
  }
  await env.BACKUP_BUCKET.put(registryKey(sandboxId), null, { customMetadata }).catch((err) => {
    console.error("sandbox registry write failed", { sandboxId, error: String(err) })
  })
}

async function unregisterSandbox(env: Env, sandboxId: string) {
  if (!env.BACKUP_BUCKET) return
  await env.BACKUP_BUCKET.delete(registryKey(sandboxId)).catch((err) => {
    // A leaked record is a GC sweep reporting a sandbox that no longer exists.
    // The control plane's destroy is idempotent (404 is success), so the next
    // sweep clears it — but log it, since a systematic failure means the
    // registry is drifting away from reality.
    console.error("sandbox registry delete failed", { sandboxId, error: String(err) })
  })
}

function registrationNames(registrations: EgressRegistration[]) {
  return registrations.map((row) => row.name).sort().join("\u0000")
}

async function readRegistrations(env: Env, sandboxId: string): Promise<EgressRegistration[]> {
  if (!env.EGRESS_SECRETS) return []
  const raw = await env.EGRESS_SECRETS.get(sandboxId)
  return raw === null ? [] : parseRegistrations(JSON.parse(raw))
}

// Well-known port the workspace-runtime binds inside the container. Keep this
// aligned with @claxedo/sandbox-manager's DEFAULT_WORKSPACE_RUNTIME_PORT: the
// control plane supplies that port to ensure-runtime and the data-plane proxy
// must forward to the same listener.
const WORKSPACE_RUNTIME_PORT = 2593
const TRACE_ID_HEADER = "x-claxedo-trace-id"
const CONTAINER_OPERATION_TIMEOUT_MS = 10_000
const SANDBOX_INSTANCE_TIMEOUT_MS = 60_000
const SANDBOX_PORT_TIMEOUT_MS = 180_000
// The first listProcesses() call is also the lazy container cold start. Its
// caller-side bound must cover both SDK startup phases plus a small RPC margin.
const SANDBOX_PROCESS_LOOKUP_TIMEOUT_MS = SANDBOX_INSTANCE_TIMEOUT_MS + SANDBOX_PORT_TIMEOUT_MS + 10_000
const RUNTIME_READY_TIMEOUT_MS = 30_000
const RUNTIME_WEDGED_AFTER_MS = RUNTIME_PREPARATION_DEADLINE_MS + 5 * 60_000
const RUNTIME_PROCESS_ID = "claxedo-workspace-runtime"
const LIVE_PROCESS: readonly SandboxProcess["status"][] = ["starting", "running"]

const SANDBOX_OPTIONS = {
  containerTimeouts: {
    instanceGetTimeoutMS: SANDBOX_INSTANCE_TIMEOUT_MS,
    portReadyTimeoutMS: SANDBOX_PORT_TIMEOUT_MS,
  },
} as const

function roundedMs(value: number) {
  return Math.round(value * 100) / 100
}

function withServerTiming(response: Response, name: string, startedAt: number, traceId: string | null) {
  if (response.status === 101 || (response as Response & { webSocket?: unknown }).webSocket) return response
  const headers = new Headers(response.headers)
  const value = `${name};dur=${roundedMs(performance.now() - startedAt)}`
  headers.set("server-timing", headers.get("server-timing") ? `${headers.get("server-timing")}, ${value}` : value)
  if (traceId) headers.set(TRACE_ID_HEADER, traceId)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

async function bounded<T>(operation: Promise<T>, name: string, timeoutMs = CONTAINER_OPERATION_TIMEOUT_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function runtimeReady(process: SandboxProcess, port: number, timeout = RUNTIME_READY_TIMEOUT_MS) {
  return process.waitForPort(port, {
    mode: "http",
    path: "/global/health",
    status: { min: 200, max: 399 },
    timeout,
  }).then(() => true).catch(() => false)
}

async function runtimeProcess(sandbox: SandboxOperations) {
  return bounded(
    sandbox.listProcesses(),
    "workspace-runtime process lookup",
    SANDBOX_PROCESS_LOOKUP_TIMEOUT_MS,
  )
    .then((processes) => processes.find((process) => process.id === RUNTIME_PROCESS_ID) ?? null)
}

async function stopRuntimeProcess(sandbox: SandboxOperations, existing: SandboxProcess | null) {
  if (!existing) return
  const status = await bounded(existing.getStatus(), "workspace-runtime process status")
  if (LIVE_PROCESS.includes(status)) {
    await bounded(existing.kill(), "workspace-runtime process kill")
  }
  await bounded(sandbox.cleanupCompletedProcesses(), "workspace-runtime process cleanup")
}

/**
 * Remembers the one process that has answered ready, by the start time the
 * container reports for it (`listProcesses`, `getProcess`).
 */
export type RuntimeReadiness = {
  runtimeWasReady(process: SandboxProcess): Promise<boolean>
  recordRuntimeReady(process: SandboxProcess): Promise<void>
}

export type RuntimeEnsure =
  | { state: "ready" }
  | { state: "preparing" }
  | { state: "exited"; reason: string }

export async function ensureRuntimeProcess(
  sandbox: SandboxOperations & RuntimeReadiness,
  command: string,
  env: Record<string, string>,
  port: number,
  options: { reuseRunning: boolean },
): Promise<RuntimeEnsure> {
  const existing = await runtimeProcess(sandbox)
  if (existing) {
    const kept = options.reuseRunning ? await keptRuntime(sandbox, existing, port) : undefined
    if (kept) return kept
    await stopRuntimeProcess(sandbox, existing)
  }
  const process = await bounded<SandboxProcess>(
    sandbox.startProcess(command, { env, processId: RUNTIME_PROCESS_ID }),
    "workspace-runtime process start",
  )
  return await settledRuntime(sandbox, process, port)
}

/**
 * What an existing runtime is, when it is to be kept: a live runtime that has
 * answered ready is never replaced for one slow health check, and one that
 * never has is still preparing its repository until it is wedged. A runtime
 * that exited before it was ever ready failed its boot; its reason is the
 * answer, because starting it again would rerun the same boot on every poll.
 */
async function keptRuntime(
  sandbox: SandboxOperations & RuntimeReadiness,
  existing: SandboxProcess,
  port: number,
): Promise<RuntimeEnsure | undefined> {
  if (!LIVE_PROCESS.includes(existing.status)) {
    if (await sandbox.runtimeWasReady(existing)) return undefined
    return { state: "exited", reason: await exitReason(sandbox, existing, existing.status) }
  }
  const settled = await settledRuntime(sandbox, existing, port)
  if (settled.state !== "preparing") return settled
  if (await sandbox.runtimeWasReady(existing)) return settled
  return Date.now() - existing.startTime.getTime() < RUNTIME_WEDGED_AFTER_MS ? settled : undefined
}

async function settledRuntime(
  sandbox: SandboxOperations & RuntimeReadiness,
  process: SandboxProcess,
  port: number,
): Promise<RuntimeEnsure> {
  if (await runtimeReady(process, port)) {
    // `startProcess` stamps its answer with the Worker's clock, never the
    // container's, so the time a later `listProcesses` reports comes from a read.
    const listed = await bounded(sandbox.getProcess(RUNTIME_PROCESS_ID), "workspace-runtime process read")
    if (listed && !await sandbox.runtimeWasReady(listed)) await sandbox.recordRuntimeReady(listed)
    return { state: "ready" }
  }
  const status = await bounded(process.getStatus(), "workspace-runtime process status")
  if (LIVE_PROCESS.includes(status)) return { state: "preparing" }
  return { state: "exited", reason: await exitReason(sandbox, process, status) }
}

/**
 * The exited runtime's own account of its failed boot, cleared away so the
 * next ensure starts a fresh one.
 */
async function exitReason(sandbox: SandboxOperations, process: SandboxProcess, status: SandboxProcess["status"]) {
  const logs = await bounded(process.getLogs(), "workspace-runtime exited process logs").catch(() => ({ stdout: "", stderr: "" }))
  console.error("workspace-runtime exited before it was ready", {
    status,
    stdout: safeRuntimeLog(logs.stdout),
    stderr: safeRuntimeLog(logs.stderr),
  })
  await bounded(sandbox.cleanupCompletedProcesses(), "workspace-runtime process cleanup")
  return bootFailure(logs.stderr) ?? `The workspace runtime process ended (${status}) before it was ready`
}

const BOOT_FAILURE_LINE = `${WORKSPACE_RUNTIME_BOOT_FAILED}: `

function bootFailure(stderr: string) {
  const at = stderr.lastIndexOf(BOOT_FAILURE_LINE)
  if (at < 0) return undefined
  const [failure = ""] = stderr.slice(at + BOOT_FAILURE_LINE.length).split(/\n\s+at /)
  return safeRuntimeLog(failure.trim().replace(/^Error: /, "")).slice(0, 1_000) || undefined
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status })
}

function auth(request: Request, env: Env): Response | null {
  const header = request.headers.get("Authorization")
  if (!header?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401)
  if (header.slice(7) !== env.API_TOKEN) return json({ error: "forbidden" }, 403)
  return null
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const parts = url.pathname.split("/").filter(Boolean)

    // ── Data-plane proxy ──────────────────────────────────────────────────
    // GET|POST|… /sandbox/:id/proxy/<rest> → forwarded straight to the
    // workspace-runtime port inside the container via the Durable Object
    // (containerFetch) — NO public preview URL, so this needs neither a custom
    // domain nor a wildcard cert; a plain workers.dev origin works.
    //
    // Deliberately NOT behind the worker API_TOKEN gate: the workspace-runtime
    // enforces its own Relay Host Token on `Authorization`, which is the SAME
    // header our admin gate uses — so consuming it here would shadow the RHT.
    // Instead we forward `Authorization` untouched and let the runtime verify
    // it: publicly reachable, token-gated by the runtime itself. The worker
    // API_TOKEN keeps gating the control actions below
    // (ensure-runtime/touch-runtime/destroy).
    if (parts[0] === "sandbox" && parts[1] && parts[2] === "proxy") {
      const startedAt = performance.now()
      const sandbox = getSandbox(env.Sandbox, parts[1], SANDBOX_OPTIONS)
      const target = new URL(request.url)
      target.pathname = "/" + parts.slice(3).join("/")
      // Rewritten Request inherits method, headers (incl. the relay's RHT) and
      // body; the streamed Response (e.g. SSE event-stream) is returned as-is.
      const proxied = new Request(target.toString(), request)
      // RPC cannot carry a Response holding a WebSocket, so an upgrade takes
      // the SDK's fetch-boundary transport.
      const response = request.headers.get("upgrade")?.toLowerCase() === "websocket"
        ? await sandbox.wsConnect(proxied, WORKSPACE_RUNTIME_PORT)
        : await sandbox.containerFetch(proxied, WORKSPACE_RUNTIME_PORT)
      return withServerTiming(
        response,
        "sandbox-container",
        startedAt,
        request.headers.get(TRACE_ID_HEADER),
      )
    }

    const denied = auth(request, env)
    if (denied) return denied

    // ── Sandbox registry listing ──────────────────────────────────────────
    // GET /sandboxes → every sandbox this Worker has recorded as live. The
    // control plane's `garbageCollect()` needs this to see orphans; a DO
    // namespace is not enumerable, so the registry (written on ensure-runtime,
    // dropped on destroy) is the only source of truth. Admin-token gated like
    // every other control action.
    //
    // Reports `supported: false` rather than an empty list when the R2 binding
    // is absent: "no bucket configured" and "no sandboxes running" must never
    // look alike to a reaper, or the sweep silently reports success while
    // seeing nothing. The driver maps this onto its listing-unsupported path.
    if (parts[0] === "sandboxes" && !parts[1]) {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405)
      if (!env.BACKUP_BUCKET) {
        return json({
          supported: false,
          error: "sandbox registry not configured (bind BACKUP_BUCKET)",
        }, 501)
      }
      const sandboxes: Array<Record<string, string>> = []
      let cursor: string | undefined
      do {
        const page = await env.BACKUP_BUCKET.list({
          prefix: REGISTRY_PREFIX,
          limit: REGISTRY_LIST_PAGE,
          include: ["customMetadata"],
          ...(cursor ? { cursor } : {}),
        })
        for (const object of page.objects) {
          const metadata = object.customMetadata ?? {}
          const sandboxId = metadata.sandboxId ?? object.key.slice(REGISTRY_PREFIX.length)
          if (sandboxId) sandboxes.push({ ...metadata, sandboxId })
        }
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
      return json({ supported: true, sandboxes })
    }

    if (parts[0] !== "sandbox" || !parts[1]) {
      return json({ error: "not found", usage: "/sandbox/:id/:action" }, 404)
    }

    const sandboxId = parts[1]
    const action = parts[2] || ""
    const sandbox = getSandbox(env.Sandbox, sandboxId, SANDBOX_OPTIONS)

    try {
      // DELETE /sandbox/:id
      if (request.method === "DELETE" && !action) {
        await sandbox.destroy()
        // Drop any brokered secrets held for this sandbox.
        await env.EGRESS_SECRETS?.delete(sandboxId).catch(() => undefined)
        // Deregister only AFTER the sandbox is actually gone: dropping the
        // record first would make a failed destroy invisible to the next sweep.
        await unregisterSandbox(env, sandboxId)
        return json({ ok: true })
      }

      if (request.method !== "POST") {
        return json({ error: "method not allowed" }, 405)
      }

      const body = asWorkerRecord(await request.json().catch(() => undefined)) ?? {}

      switch (action) {
        // Idempotent runtime bring-up that SandboxDriver.ensureHost() calls:
        //   1. set the workspace-runtime boot env (credentials),
        //   2. start the runtime process if it is not already running,
        //   3. return the worker-proxied URL for its port.
        // The URL points back at THIS worker's data-plane proxy route
        // (/sandbox/:id/proxy), not an exposePort preview subdomain — so the
        // deployment needs no custom domain or wildcard cert. Returns
        // { ready, url } so a thin edge provider needs ONE round-trip.
        case "ensure-runtime": {
          const containerEnv = stringMap(body.env)
          const port: number = typeof body.port === "number" ? body.port : WORKSPACE_RUNTIME_PORT
          const command: string = typeof body.command === "string" ? body.command : ""
          if (!command) return json({ error: "ensure-runtime requires `command`" }, 400)
          const restore = directoryRestore(body.restore)
          if (body.restore !== undefined && !restore) {
            return json({ error: "ensure-runtime restore requires one backup id for each captured directory" }, 400)
          }
          const labels = stringMap(body.labels)
          const idle = workspaceIdlePlacement(labels, port, env)
          if (!idle) {
            return json({ error: "ensure-runtime requires workspaceId and epoch labels, and CONTROL_PLANE_URL for the idle lifecycle" }, 503)
          }
          containerEnv.WORKSPACE_RUNTIME_CONFIG_TOKEN = await sandbox.configureWorkspaceIdle(idle)

          let previous: EgressRegistration[]
          try {
            previous = await readRegistrations(env, sandboxId)
          } catch {
            // Never read as "none": the previous set decides whether the
            // placeholder names changed and, when this request states no
            // egress, what stays registered — so an unreadable store would
            // silently clear a live sandbox's brokering.
            return json({ error: "egress registrations unreadable (EGRESS_SECRETS)" }, 503)
          }
          let registrations: EgressRegistration[]
          if (body.egress !== undefined) {
            try {
              registrations = parseRegistrations(body.egress)
            } catch {
              return json({ error: "invalid egress registrations" }, 400)
            }
            if (registrations.length && !env.EGRESS_SECRETS) {
              return json({ error: "egress broker requires EGRESS_SECRETS" }, 503)
            }
            await env.EGRESS_SECRETS?.put(sandboxId, JSON.stringify(registrations))
          } else {
            registrations = previous
          }
          // Which placeholders the runtime's environment must carry. Only the
          // NAMES matter: a rotated value keeps the same placeholder, so it
          // needs no new process, while an added or dropped name does.
          const placeholdersChanged = registrationNames(previous) !== registrationNames(registrations)
          await sandbox.setCredentialHosts(sandboxId, registrations.flatMap((row) => row.hosts))
          for (const row of registrations) containerEnv[row.name] = credentialPlaceholder(row.name)
          // Runtime bring-up is a Durable Object RPC with a per-sandbox
          // single-flight promise. Catalog refreshes and execution retries can
          // overlap, but they must join one process launch rather than cancel
          // each other's container operations.
          const runtime: RuntimeEnsure = await sandbox.ensureWorkspaceRuntime(command, containerEnv, port, {
            reuseRunning: !placeholdersChanged,
            ...(restore ? { restore } : {}),
          })
          if (runtime.state === "exited") return json({ ready: false, exited: true, error: runtime.reason }, 502)
          if (runtime.state === "preparing") return json({ ready: false, error: "workspace-runtime did not become ready" }, 503)
          // Register only once the sandbox is really up, and carry the labels
          // the control plane sent so GC can apply its own ownership and
          // identity checks against real provider state.
          await registerSandbox(env, sandboxId, labels)
          await sandbox.watchWorkspaceIdle()
          const proxyUrl = `${url.origin}/sandbox/${encodeURIComponent(sandboxId)}/proxy`
          return json({ ready: true, url: proxyUrl, port })
        }

        case "touch-runtime": {
          const port: number = typeof body.port === "number" ? body.port : WORKSPACE_RUNTIME_PORT
          return json({ ok: true, ready: await sandbox.workspaceRuntimeReady(port) })
        }

        case "stop": {
          if (typeof body.epoch !== "number" || !Number.isSafeInteger(body.epoch)) return json({ error: "stop requires the lease epoch" }, 400)
          const stopped: boolean = await sandbox.stopWorkspace(body.epoch, typeof body.committed === "string" ? body.committed : undefined)
          return stopped ? json({ ok: true }) : json({ ok: false, error: "a newer lease generation runs this sandbox" }, 409)
        }

        case "backup": {
          const directories = captureDirectories(body.directories)
          if (!directories) return json({ error: "backup requires distinct absolute directories, none inside another" }, 400)
          if (!env.BACKUP_BUCKET) return json({ error: "backup requires the BACKUP_BUCKET binding" }, 503)
          const backupId: string = await sandbox.captureBackups(directories, typeof body.committed === "string" ? body.committed : undefined)
          return json({ backupId })
        }

        case "delete-backup": {
          const ids = backupIds(body.backupId)
          if (!ids) return json({ error: "delete-backup requires the checkpoint's backup ids" }, 400)
          if (!env.BACKUP_BUCKET) return json({ error: "delete-backup requires the BACKUP_BUCKET binding" }, 503)
          await sandbox.deleteCheckpointBackups(ids)
          return json({ ok: true })
        }

      default:
        return json({ error: `unknown action: ${action}` }, 404)
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return json({
        error: error.message,
        name: error.name,
      }, 500)
    }
  },
}
