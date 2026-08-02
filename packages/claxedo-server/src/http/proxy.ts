import type { Context, Next } from "hono"
import { holdSupervisorSandbox, markSupervisorSandboxUse, releaseSupervisorSandbox, touchSupervisorSandbox } from "../workspace/supervisor"
import type { SandboxManager, SandboxEnsureResult } from "@claxedo/sandbox-manager"
import { resolveWorkspace } from "../workspace/store"
import { opencodeHeaders } from "../opencode/auth"
import { isLoopbackLocalRequest } from "../routes/local-only-projection"
import { errorBody } from "../routes/http"
import { ensureEmbeddedWorkspaceRuntime, type EmbeddedWorkspaceRuntimeConfigMode } from "../deployments/local/embedded-workspace-runtime"
import { routeOwnership, RouteHandler } from "../governance/route-ownership"
import { normalizeClaxedoRegion, type ClaxedoRegion } from "../region"
import type { RelayProvider } from "../adapters/relay"

const WR_INTERNAL = ["/api/wr/health", "/api/wr/config", "/api/wr/harness-config-options", "/api/wr/capabilities"]

type Hit = {
  workspaceId: string
  workspaceName?: string
  directory: string
  url: string
  relay?: {
    hostId: string
    homeRegion?: ClaxedoRegion
    orgId: string
  }
}

export type RuntimeProxyOptions = {
  sandboxManager?: SandboxManager
  relayProvider?: RelayProvider
  defaultHomeRegion?: ClaxedoRegion
}

// Cloud runtime startup can legitimately take minutes on cold sandboxes
// while clone/install/health checks complete. Keep this proxy timeout above
// the runtime's own startup budget so early requests don't fail with a false
// "workspace runtime unavailable" while provisioning is still in progress.
const RUNTIME_WAIT_MS = 10 * 60_000
const DEFAULT_REMOTE_DIRECTORY = "/workspace"

function runtimeOwned(pathname: string) {
  if (WR_INTERNAL.includes(pathname)) return true
  return routeOwnership(pathname).handler === RouteHandler.SandboxRuntime
}

function requestWorkspace(c: Context) {
  const dir = c.req.query("directory") || c.req.header("x-opencode-directory")
  return {
    workspaceId: c.req.query("workspaceId") || c.req.query("workspace") || c.req.header("x-workspace-id"),
    directory: dir ? decodeURIComponent(dir) : undefined,
  }
}

export async function resolveWorkspaceRuntimeHit(c: Context, options: RuntimeProxyOptions = {}): Promise<Hit | undefined> {
  const input = requestWorkspace(c)
  const ws = await resolveWorkspace({
    workspaceId: input.workspaceId,
    directory: input.directory,
  })
  return await resolveWorkspaceHit(ws, options)
}

export async function resolveWorkspaceRuntimeHitForWorkspaceId(
  workspaceId: string,
  options: RuntimeProxyOptions = {},
): Promise<Hit | undefined> {
  return await resolveWorkspaceHit(await resolveWorkspace({ workspaceId }), options)
}

async function resolveWorkspaceHit(
  ws: Awaited<ReturnType<typeof resolveWorkspace>>,
  options: RuntimeProxyOptions = {},
): Promise<Hit | undefined> {
  if (!ws) return
  if (ws.kind !== "cloud") return
  const pending = ensureCloudRuntime(ws, options)
  const runtime = await Promise.race([
    pending,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("workspace runtime startup timed out")), RUNTIME_WAIT_MS),
    ),
  ]).catch((err) => {
    void pending.catch(() => undefined)
    throw err
  })
  return {
    workspaceId: ws.id,
    workspaceName: ws.workspace_name || ws.project_name || ws.repo_name || undefined,
    directory: ws.remote_directory || DEFAULT_REMOTE_DIRECTORY,
    url: runtime.url,
    ...(runtime.relay ? { relay: runtime.relay } : {}),
  }
}

async function ensureCloudRuntime(
  ws: NonNullable<Awaited<ReturnType<typeof resolveWorkspace>>>,
  options: RuntimeProxyOptions,
) {
  if (!options.sandboxManager) throw new Error(`sandbox manager unavailable: ${ws.id}`)
  const result = await options.sandboxManager.ensure(ws.id, {
    homeRegion: options.defaultHomeRegion ?? "us-east",
  })
  if (result.status !== "ready") throw new Error(sandboxUnavailableDetail(result))
  return {
    url: result.url,
    ...(options.relayProvider && ws.org_id
      ? {
          relay: {
            hostId: result.hostId,
            homeRegion: normalizeClaxedoRegion(result.homeRegion, options.defaultHomeRegion ?? "us-east"),
            orgId: ws.org_id,
          },
        }
      : {}),
  }
}

function sandboxUnavailableDetail(result: Exclude<SandboxEnsureResult, { status: "ready" }>) {
  if (result.status === "provisioning") return `sandbox provisioning; retry after ${result.retryAfterMs}ms`
  return result.error ?? "sandbox unavailable"
}

function noWr(c: Context, err?: unknown) {
  const input = requestWorkspace(c)
  const msg = err instanceof Error ? err.message : undefined
  return c.json(
    {
      error: {
        code: "workspace_runtime_unavailable",
        message: "workspace runtime unavailable",
        ...(msg ? { detail: msg } : {}),
      },
      workspaceId: input.workspaceId ?? null,
      directory: input.directory ?? null,
    },
    503,
  )
}

function streaming(pathname: string, headers: Headers) {
  if (pathname === "/global/event" || pathname === "/event") return true
  const type = headers.get("content-type") || ""
  return type.includes("text/event-stream")
}

export function runtimeProxyResponseHeaders(headers: Headers) {
  const next = new Headers(headers)
  // Node fetch decompresses gzip/br responses but preserves the upstream
  // content-encoding header. Forwarding that stale header makes browsers
  // attempt a second decompression and fail with ERR_CONTENT_DECODING_FAILED.
  if (next.has("content-encoding")) {
    next.delete("content-encoding")
    next.delete("content-length")
  }
  return next
}

async function proxy(c: Context, hit: Hit, options?: {
  pathname?: string
  forwardedBy?: string
  sandboxManager?: SandboxManager
  relayProvider?: RelayProvider
  defaultHomeRegion?: ClaxedoRegion
}) {
  const url = new URL(c.req.url)
  const target = await proxyTarget(hit, options, (options?.pathname ?? url.pathname) + url.search)
  const headers = opencodeHeaders(c.req.raw.headers)
  headers.set("x-workspace-id", hit.workspaceId)
  if (hit.workspaceName) headers.set("x-workspace-name", hit.workspaceName)
  headers.set("x-opencode-directory", hit.relay ? `workspace:${hit.workspaceId}` : hit.directory)
  if (options?.forwardedBy) headers.set("x-forwarded-by", options.forwardedBy)
  if (!hit.relay) headers.set("X-Daytona-Skip-Preview-Warning", "true")
  headers.delete("host")
  headers.delete("connection")
  // Prevent the upstream from compressing responses. Node's fetch (undici)
  // auto-decompresses, but the Daytona proxy layer can produce responses
  // where the content-encoding header and actual body encoding disagree,
  // causing Z_DATA_ERROR (incorrect header check) during decompression.
  // Requesting identity encoding avoids the mismatch entirely.
  headers.set("accept-encoding", "identity")
  // SECURITY — this branch mints a `subject:"control-plane"`, `role:"owner"`
  // Relay Host Token. Two callers reach it: the signed/hosted path via
  // `resolveWorkspaceHit`, and `localWorkspaceRelayProxy`, which serves
  // BROWSER-ORIGINATED traffic and is the path the app actually takes for a
  // relay-backed workspace on a loopback server URL
  // (`workspace-runtime-request.ts:223`). The only thing standing between a
  // local process and an owner-role token on that second path is
  // `isLoopbackLocalRequest` (`local-only-projection.ts`), checked at the top of
  // `localWorkspaceRelayProxyWithOptions` — it fails closed on forwarded
  // headers and verifies peer address, host, and origin. That gate is
  // load-bearing for this mint, not just for the local projections it was
  // written for: weakening it (e.g. trusting a forwarded client claim here)
  // hands out owner tokens. `localWorkspaceRelayProxy denies a forwarded-client
  // request before minting` in proxy.test.ts pins the ordering.
  if (hit.relay && options?.relayProvider) {
    const token = await options.relayProvider.mintRuntimeAccessToken({
      workspaceId: hit.workspaceId,
      hostId: hit.relay.hostId,
      subject: "control-plane",
      orgId: hit.relay.orgId,
      role: "owner",
      ttlMs: 10 * 60_000,
    })
    headers.set("authorization", `Bearer ${token.token}`)
  }

  const req = new Request(target.toString(), {
    method: c.req.method,
    headers,
    body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
    // @ts-ignore
    duplex: "half",
  })

  const res = await fetch(req)
  markSupervisorSandboxUse(hit.workspaceId)
  if (options?.sandboxManager?.touch) void options.sandboxManager.touch(hit.workspaceId).catch(() => undefined)
  if (!options?.sandboxManager) touchSupervisorSandbox(hit.workspaceId)
  if (!res.body || !streaming(url.pathname, res.headers)) {
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: runtimeProxyResponseHeaders(res.headers),
    })
  }

  holdSupervisorSandbox(hit.workspaceId)
  const reader = res.body.getReader()
  let released = false
  const release = () => {
    if (released) return
    released = true
    releaseSupervisorSandbox(hit.workspaceId)
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        const next = await reader.read()
        if (next.done) {
          release()
          ctrl.close()
          return
        }
        ctrl.enqueue(next.value)
      } catch (err) {
        release()
        await reader.cancel(err).catch(() => undefined)
        ctrl.error(err)
      }
    },
    async cancel(reason) {
      release()
      await reader.cancel(reason)
    },
  })

  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: runtimeProxyResponseHeaders(res.headers),
  })
}

async function proxyTarget(hit: Hit, options: Parameters<typeof proxy>[2], path: string) {
  if (hit.relay && options?.relayProvider) {
    const relayUrl = await options.relayProvider.getRelayEndpoint(
      hit.workspaceId,
      hit.relay.homeRegion ?? options.defaultHomeRegion ?? "us-east",
    )
    const workspacePath = new URL(path, "http://sandbox-manager.local")
    return new URL(
      `/workspaces/${encodeURIComponent(hit.workspaceId)}${workspacePath.pathname}${workspacePath.search}`,
      relayUrl.replace(/\/+$/, ""),
    )
  }
  const target = new URL(path, hit.url)
  // Rewrite directory query param to the remote directory for direct local
  // compatibility. Relay-backed proxying routes by workspace identity.
  if (target.searchParams.has("directory")) {
    target.searchParams.set("directory", hit.directory)
  }
  return target
}

export function embeddedConfigModeForPath(pathname: string): EmbeddedWorkspaceRuntimeConfigMode {
  if (
    pathname === "/api/wr/health"
    || pathname === "/api/wr/capabilities"
    || pathname === "/global/event"
    || pathname === "/event"
    || pathname === "/api/wr/events"
    || pathname === "/api/wr/runtime-events"
    || pathname === "/lsp"
    || pathname === "/vcs"
    || pathname === "/file"
    || pathname.startsWith("/file/")
    || pathname === "/find"
    || pathname.startsWith("/find/")
    || pathname === "/api/wr/pty"
    || pathname.startsWith("/api/wr/pty/")
    || pathname === "/api/wr/process"
    || pathname.startsWith("/api/wr/process/")
    || pathname === "/api/wr/diff"
    || pathname.startsWith("/api/wr/diff/")
    || pathname === "/api/wr/git"
    || pathname.startsWith("/api/wr/git/")
  ) return "skip"
  return "sync"
}

async function embedded(c: Context, ws: NonNullable<Awaited<ReturnType<typeof resolveWorkspace>>>, pathname?: string) {
  const url = new URL(c.req.url)
  const targetPath = pathname ?? url.pathname
  const runtime = await ensureEmbeddedWorkspaceRuntime(ws, { config: embeddedConfigModeForPath(targetPath) })
  const target = new URL(targetPath + url.search, "http://embedded-workspace-runtime.local")
  if (target.searchParams.has("directory")) target.searchParams.set("directory", ws.directory)
  const headers = opencodeHeaders(c.req.raw.headers)
  headers.set("x-workspace-id", ws.id)
  headers.set("x-opencode-directory", ws.directory)
  headers.delete("host")
  headers.delete("connection")
  const res = await runtime.app.fetch(new Request(target.toString(), {
    method: c.req.method,
    headers,
    body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
    // @ts-ignore
    duplex: "half",
  }))
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: runtimeProxyResponseHeaders(res.headers),
  })
}

export function createWorkspaceRuntimeProxy(options: RuntimeProxyOptions = {}) {
  return (c: Context, next: Next) => workspaceRuntimeProxyWithOptions(c, next, options)
}

export async function workspaceRuntimeProxy(c: Context, next: Next): Promise<Response | void> {
  return workspaceRuntimeProxyWithOptions(c, next)
}

async function workspaceRuntimeProxyWithOptions(
  c: Context,
  next: Next,
  options: RuntimeProxyOptions = {},
): Promise<Response | void> {
  const pathname = new URL(c.req.url).pathname

  if (!runtimeOwned(pathname)) return next()

  try {
    const input = requestWorkspace(c)
    const ws = await resolveWorkspace({
      workspaceId: input.workspaceId,
      directory: input.directory,
    })
    if (!ws) return next()
    if (ws.kind !== "cloud") return await embedded(c, ws)
    const hit = await resolveWorkspaceHit(ws, options)
    if (!hit) return next()
    return await proxy(c, hit, {
      sandboxManager: options.sandboxManager,
      ...(options.relayProvider ? { relayProvider: options.relayProvider } : {}),
      ...(options.defaultHomeRegion ? { defaultHomeRegion: options.defaultHomeRegion } : {}),
    })
  } catch (err) {
    return noWr(c, err)
  }
}

export function createLocalWorkspaceRelayProxy(options: RuntimeProxyOptions = {}) {
  return (c: Context) => localWorkspaceRelayProxyWithOptions(c, options)
}

export async function localWorkspaceRelayProxy(c: Context): Promise<Response> {
  return localWorkspaceRelayProxyWithOptions(c)
}

async function localWorkspaceRelayProxyWithOptions(c: Context, options: RuntimeProxyOptions = {}): Promise<Response> {
  if (!isLoopbackLocalRequest(c.req.raw)) {
    return c.json(errorBody("workspace_relay_local_loopback_required", "Local workspace relay proxy requires loopback access"), 401)
  }
  const workspaceId = c.req.param("workspaceId")
  if (!workspaceId) return c.json(errorBody("workspace_relay_workspace_required", "workspaceId is required"), 400)
  const ws = await resolveWorkspace({ workspaceId })
  if (!ws) {
    return c.json(errorBody("workspace_relay_workspace_not_found", "Workspace not found"), 404)
  }
  try {
    const pathname = new URL(c.req.url).pathname.replace(/^\/workspaces\/[^/]+/, "") || "/"
    if (ws.kind !== "cloud") return await embedded(c, ws, pathname)
    const runtime = await ensureCloudRuntime(ws, options)
    const current = await resolveWorkspace({ workspaceId: ws.id }) ?? ws
    const hit = {
      workspaceId: ws.id,
      workspaceName: current.workspace_name || current.project_name || current.repo_name || undefined,
      directory: current.remote_directory || DEFAULT_REMOTE_DIRECTORY,
      url: runtime.url,
      // `proxy()` mints the Relay Host Token this cloud runtime demands ONLY
      // when the hit carries `relay` (see the mint branch there). Dropping it
      // here — as this inline hit used to, unlike `resolveWorkspaceHit` which
      // forwards it — meant every request the browser sent through this
      // loopback proxy reached the runtime carrying the USER's bearer token
      // instead of a relay token, and came back 401 `relay_host_token_required`
      // / `invalid_relay_token`. On a loopback server URL this proxy is the
      // path the app actually takes for a relay-backed workspace
      // (`workspace-runtime-request.ts:223`), so a local cloud workspace could
      // never finish connecting: the gate sat on "Preparing workspace" forever.
      ...(runtime.relay ? { relay: runtime.relay } : {}),
    }
    return await proxy(c, hit, {
      pathname,
      forwardedBy: "workspace-relay",
      sandboxManager: options.sandboxManager,
      ...(options.relayProvider ? { relayProvider: options.relayProvider } : {}),
      ...(options.defaultHomeRegion ? { defaultHomeRegion: options.defaultHomeRegion } : {}),
    })
  } catch (err) {
    return noWr(c, err)
  }
}
