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
export class Sandbox extends CloudflareSandboxBase {}

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

async function runtimeReady(sandbox: ReturnType<typeof getSandbox>, url: URL, port: number) {
  const target = new URL("/global/health", url.origin)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const ready = await sandbox
      .containerFetch(new Request(target), port)
      .then((res: Response) => res.ok)
      .catch(() => false)
    if (ready) return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
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
    const sandbox = getSandbox(env.Sandbox, sandboxId)

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
          await sandbox.setEnvVars(containerEnv)
          // One sentinel process per sandbox: a marker file makes the start
          // idempotent so re-poll/resume does not spawn duplicate runtimes.
          const marker = "/tmp/.claxedo-runtime-started"
          const already = await sandbox
            .exec(`test -f ${marker} && echo yes || echo no`, { timeout: 5000 })
            .then((r: any) => (r.stdout ?? "").trim() === "yes")
            .catch(() => false)
          if (!already) {
            await sandbox.startProcess(command, { envVars: containerEnv })
          }
          if (!await runtimeReady(sandbox, url, port)) {
            await sandbox.exec(`rm -f ${marker}`, { timeout: 5000 }).catch(() => undefined)
            return json({ ready: false, error: "workspace-runtime did not become ready" }, 503)
          }
          await sandbox.exec(`touch ${marker}`, { timeout: 5000 }).catch(() => undefined)
          const proxyUrl = `${url.origin}/sandbox/${encodeURIComponent(sandboxId)}/proxy`
          return json({ ready: true, url: proxyUrl, port })
        }

        case "touch-runtime": {
          const port: number = typeof body.port === "number" ? body.port : WORKSPACE_RUNTIME_PORT
          return json({ ok: true, ready: await runtimeReady(sandbox, url, port) })
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
