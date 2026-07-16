/**
 * Cloudflare Worker that proxies sandbox operations over HTTP.
 *
 * Deploy: cd cloudflare-worker && npm install && wrangler deploy
 * Set secret: wrangler secret put API_TOKEN
 */
import { getSandbox, Sandbox as CloudflareSandbox } from "@cloudflare/sandbox"
import { EGRESS_TARGET_HEADER, handleEgressRequest, mintEgressToken } from "./egress"

// Local export is required for Wrangler's [[containers]].class_name binding to
// attach this Worker's Dockerfile to the Durable Object class.
const CloudflareSandboxBase = CloudflareSandbox as new (...args: never[]) => object
export class Sandbox extends CloudflareSandboxBase {
  private workspaceRuntimeEnsure?: Promise<boolean>

  ensureWorkspaceRuntime(command: string, env: Record<string, string>, port: number) {
    if (this.workspaceRuntimeEnsure) return this.workspaceRuntimeEnsure
    const operation = ensureRuntimeProcess(this as unknown as SandboxOperations, command, env, port)
    this.workspaceRuntimeEnsure = operation
    return operation.finally(() => {
      if (this.workspaceRuntimeEnsure === operation) this.workspaceRuntimeEnsure = undefined
    })
  }

  async workspaceRuntimeReady(port: number) {
    const process = await runtimeProcess(this as unknown as SandboxOperations)
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

interface Env {
  Sandbox: any
  API_TOKEN: string
  /** HMAC secret for sandbox egress tokens (wrangler secret put EGRESS_SIGNING_SECRET). Optional — brokering off when unset. */
  EGRESS_SIGNING_SECRET?: string
  /** KV namespace holding brokered secrets keyed by sandbox id, out of the container. */
  EGRESS_SECRETS?: EgressKV
}

type EgressRegistration = { hosts: string[]; header: string; value: string }

// Look up the brokered credential for a (sandbox, host) pair from KV — Worker
// side only; the value never round-trips through the container.
async function resolveEgressSecret(env: Env, sandboxId: string, host: string) {
  const raw = await env.EGRESS_SECRETS?.get(sandboxId)
  if (!raw) return undefined
  const registrations = JSON.parse(raw) as EgressRegistration[]
  const match = registrations.find((reg) => reg.hosts.includes(host))
  return match ? { header: match.header, value: match.value } : undefined
}

// Well-known port the workspace-runtime binds inside the container (matches the
// provider's CLAXEDO_WR_PORT default). The data-plane proxy forwards here.
const WORKSPACE_RUNTIME_PORT = 3002
const TRACE_ID_HEADER = "x-claxedo-trace-id"
const CONTAINER_OPERATION_TIMEOUT_MS = 10_000
const RUNTIME_READY_TIMEOUT_MS = 30_000
const RUNTIME_PROCESS_ID = "claxedo-workspace-runtime"

interface SandboxProcess {
  id: string
  status: "starting" | "running" | "completed" | "failed" | "killed" | "error"
  kill(signal?: string): Promise<void>
  getStatus(): Promise<SandboxProcess["status"]>
  getLogs(): Promise<{ stdout: string; stderr: string }>
  waitForPort(port: number, options: {
    mode: "http"
    path: string
    status: { min: number; max: number }
    timeout: number
  }): Promise<void>
}

interface SandboxOperations {
  listProcesses(): Promise<SandboxProcess[]>
  startProcess(command: string, options: {
    env: Record<string, string>
    processId: string
  }): Promise<SandboxProcess>
  cleanupCompletedProcesses(): Promise<number>
}

interface ManagedSandbox {
  ensureWorkspaceRuntime(command: string, env: Record<string, string>, port: number): Promise<boolean>
  workspaceRuntimeReady(port: number): Promise<boolean>
}

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
  return bounded(sandbox.listProcesses(), "workspace-runtime process lookup")
    .then((processes) => processes.find((process) => process.id === RUNTIME_PROCESS_ID) ?? null)
}

async function ensureRuntimeProcess(
  sandbox: SandboxOperations,
  command: string,
  env: Record<string, string>,
  port: number,
) {
  const existing = await runtimeProcess(sandbox)
  if (existing && ["starting", "running"].includes(existing.status) && await runtimeReady(existing, port, 5_000)) return true
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
      const sandbox = getSandbox(env.Sandbox, parts[1])
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

    // ── Egress credential broker ──────────────────────────────────────────
    // The sandbox routes outbound requests for brokered hosts here, carrying
    // only its short-lived egress JWT (never the credential). We validate the
    // token, inject the real credential from KV, and forward. NOT behind the
    // admin API_TOKEN gate — it is authenticated by the per-sandbox egress JWT.
    if (parts[0] === "egress") {
      if (!env.EGRESS_SIGNING_SECRET) return json({ error: "egress broker not configured" }, 503)
      return handleEgressRequest(request, {
        signingSecret: env.EGRESS_SIGNING_SECRET,
        resolveSecret: (sandboxId, host) => resolveEgressSecret(env, sandboxId, host),
      })
    }

    const denied = auth(request, env)
    if (denied) return denied

    if (parts[0] !== "sandbox" || !parts[1]) {
      return json({ error: "not found", usage: "/sandbox/:id/:action" }, 404)
    }

    const sandboxId = parts[1]
    const action = parts[2] || ""
    const sandbox = getSandbox(env.Sandbox, sandboxId) as ReturnType<typeof getSandbox> & ManagedSandbox

    try {
      // DELETE /sandbox/:id
      if (request.method === "DELETE" && !action) {
        await sandbox.destroy()
        // Drop any brokered secrets held for this sandbox.
        await env.EGRESS_SECRETS?.delete(sandboxId).catch(() => undefined)
        return json({ ok: true })
      }

      if (request.method !== "POST") {
        return json({ error: "method not allowed" }, 405)
      }

      const body = await request.json().catch(() => ({})) as Record<string, any>

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
          const containerEnv = (body.env ?? {}) as Record<string, string>
          const port: number = typeof body.port === "number" ? body.port : WORKSPACE_RUNTIME_PORT
          const command: string = typeof body.command === "string" ? body.command : ""
          if (!command) return json({ error: "ensure-runtime requires `command`" }, 400)

          // Brokered secrets: store the raw values in KV (out of the container)
          // and give the container only the proxy URL + a short-lived JWT +
          // the brokered host list — never the values.
          const egress = Array.isArray(body.egress) ? (body.egress as EgressRegistration[]) : undefined
          if (egress?.length) {
            if (!env.EGRESS_SIGNING_SECRET || !env.EGRESS_SECRETS) {
              return json({ error: "egress broker not configured (set EGRESS_SIGNING_SECRET + EGRESS_SECRETS)" }, 503)
            }
            await env.EGRESS_SECRETS.put(sandboxId, JSON.stringify(egress))
            const hosts = [...new Set(egress.flatMap((reg) => reg.hosts))]
            containerEnv.CLAXEDO_EGRESS_PROXY_URL = `${url.origin}/egress`
            containerEnv.CLAXEDO_EGRESS_TARGET_HEADER = EGRESS_TARGET_HEADER
            containerEnv.CLAXEDO_EGRESS_HOSTS = JSON.stringify(hosts)
            containerEnv.CLAXEDO_EGRESS_TOKEN = await mintEgressToken({
              sandboxId,
              hosts,
              signingSecret: env.EGRESS_SIGNING_SECRET,
            })
          }
          // Runtime bring-up is a Durable Object RPC with a per-sandbox
          // single-flight promise. Catalog refreshes and execution retries can
          // overlap, but they must join one process launch rather than cancel
          // each other's container operations.
          if (!await sandbox.ensureWorkspaceRuntime(command, containerEnv, port)) {
            return json({ ready: false, error: "workspace-runtime did not become ready" }, 503)
          }
          const proxyUrl = `${url.origin}/sandbox/${encodeURIComponent(sandboxId)}/proxy`
          return json({ ready: true, url: proxyUrl, port })
        }

        case "touch-runtime": {
          const port: number = typeof body.port === "number" ? body.port : WORKSPACE_RUNTIME_PORT
          return json({ ok: true, ready: await sandbox.workspaceRuntimeReady(port) })
        }

      default:
        return json({ error: `unknown action: ${action}` }, 404)
      }
    } catch (err: any) {
      return json({
        error: err.message || String(err),
        stack: err.stack,
        name: err.name,
      }, 500)
    }
  },
}
