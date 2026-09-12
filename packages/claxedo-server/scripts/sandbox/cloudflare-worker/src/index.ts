/**
 * Cloudflare Worker that proxies sandbox operations over HTTP.
 *
 * Deploy: cd cloudflare-worker && npm install && wrangler deploy
 * Set secret: wrangler secret put API_TOKEN
 */
import {
  ContainerProxy,
  getSandbox,
  Sandbox as CloudflareSandbox,
  type SandboxOperations,
  type SandboxProcess,
} from "@cloudflare/sandbox"
import { credentialPlaceholder, forwardCredential, parseRegistrations, type EgressRegistration } from "./outbound-credentials"
import { asWorkerRecord, stringMap } from "./worker-json"

// Cloudflare routes intercepted container HTTP(S) through this Worker
// Entrypoint. Without the export, the local sidecar accepts TLS and then has no
// Worker target to forward to; production uses the same SDK contract.
export { ContainerProxy }

// Local export is required for Wrangler's [[containers]].class_name binding to
// attach this Worker's Dockerfile to the Durable Object class. The process
// operations `this` is passed to live on the ambient `@cloudflare/sandbox`
// declaration, so no call site re-asserts `this`.
/** Registration and dispatch must name the same handler; a literal on each side is a silent 520. */
const CREDENTIAL_OUTBOUND_HANDLER = "credential"

export class Sandbox extends CloudflareSandbox {
  static {
    // The SDK registers handlers through an inherited setter, not a static field.
    Object.assign(this, { outboundHandlers: {
      [CREDENTIAL_OUTBOUND_HANDLER]: (request: Request, env: Env, ctx: { params: { sandboxId: string } }) =>
        forwardCredential(request, { registrations: () => readRegistrations(env, ctx.params.sandboxId) }),
    } })
  }
  interceptHttps = true

  private workspaceRuntimeEnsure?: Promise<boolean>

  /**
   * `reuseRunning: false` is how a caller says the boot env changed. A running
   * process keeps the environment it was spawned with, so a credential
   * registered after boot never becomes its placeholder env var until the
   * process itself is replaced.
   */
  ensureWorkspaceRuntime(command: string, env: Record<string, string>, port: number, options: { reuseRunning: boolean }) {
    if (this.workspaceRuntimeEnsure) return this.workspaceRuntimeEnsure
    const operation = ensureRuntimeProcess(this, command, env, port, options)
    this.workspaceRuntimeEnsure = operation
    return operation.finally(() => {
      if (this.workspaceRuntimeEnsure === operation) this.workspaceRuntimeEnsure = undefined
    })
  }

  async workspaceRuntimeReady(port: number) {
    const process = await runtimeProcess(this)
    return Boolean(process && await runtimeReady(process, port, 2_000))
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

interface Env {
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
const RUNTIME_PROCESS_ID = "claxedo-workspace-runtime"

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

async function stopRuntimeProcess(sandbox: SandboxOperations) {
  const existing = await runtimeProcess(sandbox)
  if (!existing) return
  const status = await bounded(existing.getStatus(), "workspace-runtime process status")
  if (["starting", "running"].includes(status)) {
    await bounded(existing.kill(), "workspace-runtime process kill")
  }
  await bounded(sandbox.cleanupCompletedProcesses(), "workspace-runtime process cleanup")
}

export async function ensureRuntimeProcess(
  sandbox: SandboxOperations,
  command: string,
  env: Record<string, string>,
  port: number,
  options: { reuseRunning: boolean },
) {
  const existing = await runtimeProcess(sandbox)
  if (
    options.reuseRunning && existing && ["starting", "running"].includes(existing.status)
    && await runtimeReady(existing, port, 5_000)
  ) return true
  if (existing) {
    const status = await bounded(existing.getStatus(), "workspace-runtime process status")
    if (["starting", "running"].includes(status)) {
      await bounded(existing.kill(), "stale workspace-runtime process kill")
    }
    await bounded(sandbox.cleanupCompletedProcesses(), "workspace-runtime process cleanup")
  }

  const process = await bounded<SandboxProcess>(
    sandbox.startProcess(command, { env, processId: RUNTIME_PROCESS_ID }),
    "workspace-runtime process start",
  )
  if (await runtimeReady(process, port)) return true

  const status = await bounded(process.getStatus(), "workspace-runtime failed process status").catch(() => process.status)
  const logs = await bounded(process.getLogs(), "workspace-runtime failed process logs").catch(() => ({ stdout: "", stderr: "" }))
  console.error("workspace-runtime failed to become ready", {
    status,
    stdout: safeRuntimeLog(logs.stdout),
    stderr: safeRuntimeLog(logs.stderr),
  })
  return false
}

function safeRuntimeLog(value: string) {
  return value
    .slice(-4_000)
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED PEM]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|COOKIE)[A-Z0-9_]*)=\S+/gi, "$1=[REDACTED]")
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
    // it. Same trust model as Daytona's preview URLs: publicly reachable,
    // token-gated by the runtime itself. The worker API_TOKEN keeps gating the
    // control actions below (ensure-runtime/touch-runtime/destroy).
    if (parts[0] === "sandbox" && parts[1] && parts[2] === "proxy") {
      const startedAt = performance.now()
      const sandbox = getSandbox(env.Sandbox, parts[1], SANDBOX_OPTIONS)
      const target = new URL(request.url)
      target.pathname = "/" + parts.slice(3).join("/")
      // Rewritten Request inherits method, headers (incl. the relay's RHT) and
      // body; the streamed Response (e.g. SSE event-stream) is returned as-is.
      const proxied = new Request(target.toString(), request)
      return withServerTiming(
        await sandbox.containerFetch(proxied, WORKSPACE_RUNTIME_PORT),
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
            return json({ error: "ensure-runtime restore requires one absolute directory and a backupId" }, 400)
          }

          const previous = await readRegistrations(env, sandboxId)
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
          await sandbox.setOutboundByHosts(Object.fromEntries(
            registrations.flatMap((row) => row.hosts.map((host) =>
              [host, { method: CREDENTIAL_OUTBOUND_HANDLER, params: { sandboxId } }],
            )),
          ))
          for (const row of registrations) containerEnv[row.name] = credentialPlaceholder(row.name)
          if (restore) {
            // Cloudflare backup mounts are ephemeral and restoring over an
            // active writer is unsafe. Stop the old runtime before mounting
            // the requested backup, then boot against the restored directory.
            await stopRuntimeProcess(sandbox)
            await sandbox.restoreBackup({ id: restore.backupId, dir: restore.directory })
          }
          // Runtime bring-up is a Durable Object RPC with a per-sandbox
          // single-flight promise. Catalog refreshes and execution retries can
          // overlap, but they must join one process launch rather than cancel
          // each other's container operations.
          if (!await sandbox.ensureWorkspaceRuntime(command, containerEnv, port, { reuseRunning: !placeholdersChanged })) {
            return json({ ready: false, error: "workspace-runtime did not become ready" }, 503)
          }
          // Register only once the sandbox is really up, and carry the labels
          // the control plane sent so GC can apply its own ownership and
          // identity checks against real provider state.
          await registerSandbox(env, sandboxId, stringMap(body.labels))
          const proxyUrl = `${url.origin}/sandbox/${encodeURIComponent(sandboxId)}/proxy`
          return json({ ready: true, url: proxyUrl, port })
        }

        case "touch-runtime": {
          const port: number = typeof body.port === "number" ? body.port : WORKSPACE_RUNTIME_PORT
          return json({ ok: true, ready: await sandbox.workspaceRuntimeReady(port) })
        }

        case "backup": {
          const directory = singleDirectory(body.directories)
          if (!directory) return json({ error: "backup requires exactly one absolute directory" }, 400)
          const backup = await sandbox.createBackup({ dir: directory })
          return json({ backupId: backup.id, directory: backup.dir })
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

function singleDirectory(input: unknown) {
  if (!Array.isArray(input) || input.length !== 1 || typeof input[0] !== "string") return undefined
  const directory = input[0]
  if (!directory.startsWith("/") || directory.split("/").includes("..")) return undefined
  return directory
}

function directoryRestore(input: unknown) {
  const restore = asWorkerRecord(input)
  if (!restore) return undefined
  const directory = singleDirectory(restore.directories)
  if (!directory || typeof restore.backupId !== "string" || !restore.backupId) return undefined
  return { backupId: restore.backupId, directory }
}

