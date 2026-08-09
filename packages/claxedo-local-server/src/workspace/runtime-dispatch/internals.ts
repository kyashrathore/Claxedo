import type { Context, Next } from "hono"
import { workspaceSupervisor } from "@claxedo/server-core/workspace/supervisor-port"
import type { SandboxEnsureResult, SandboxManagerPort } from "@claxedo/server-core/sandbox/manager-port"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { opencodeHeaders } from "@claxedo/server-core/opencode/auth"
import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"
import { errorBody } from "@claxedo/server-core/platform/http/http"
import { ensureEmbeddedWorkspaceRuntime, type EmbeddedWorkspaceRuntimeConfigMode } from "../../deployments/local/embedded-workspace-runtime"
import { routeOwnership, RouteHandler } from "@claxedo/server-core/platform/governance/route-ownership"
import { normalizeClaxedoRegion, type ClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import type { RelayProvider } from "@claxedo/server-core/adapters/relay/index"

const WR_INTERNAL = ["/api/wr/health", "/api/wr/config", "/api/wr/harness-config-options", "/api/wr/capabilities"]

export type Hit = {
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
  sandboxManager?: Pick<SandboxManagerPort, "ensure" | "touch">
  relayProvider?: RelayProvider
  defaultHomeRegion?: ClaxedoRegion
}

// Cloud runtime startup can legitimately take minutes on cold sandboxes
// while clone/install/health checks complete. Keep this proxy timeout above
// the runtime's own startup budget so early requests don't fail with a false
// "workspace runtime unavailable" while provisioning is still in progress.
const RUNTIME_WAIT_MS = 10 * 60_000
const DEFAULT_REMOTE_DIRECTORY = "/workspace"

export function runtimeOwned(pathname: string) {
  if (WR_INTERNAL.includes(pathname)) return true
  return routeOwnership(pathname).handler === RouteHandler.SandboxRuntime
}

export function requestWorkspace(c: Context) {
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

export async function resolveWorkspaceHit(
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

export async function ensureCloudRuntime(
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

export function noWr(c: Context, err?: unknown) {
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

export async function proxy(c: Context, hit: Hit, options?: {
  pathname?: string
  forwardedBy?: string
  sandboxManager?: Pick<SandboxManagerPort, "ensure" | "touch">
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
  workspaceSupervisor().markUse(hit.workspaceId)
  if (options?.sandboxManager?.touch) void options.sandboxManager.touch(hit.workspaceId).catch(() => undefined)
  if (!options?.sandboxManager) workspaceSupervisor().touch(hit.workspaceId)
  if (!res.body || !streaming(url.pathname, res.headers)) {
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: runtimeProxyResponseHeaders(res.headers),
    })
  }

  workspaceSupervisor().hold(hit.workspaceId)
  const reader = res.body.getReader()
  let released = false
  const release = () => {
    if (released) return
    released = true
    workspaceSupervisor().release(hit.workspaceId)
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

export function embeddedConfigModeForPath(
  pathname: string,
  method = "GET",
): EmbeddedWorkspaceRuntimeConfigMode {
  // Runtime configuration is a launch/mutation precondition, not a read
  // precondition. If an extension cannot be materialized safely (for example,
  // because an unmanaged skill already occupies its target), blocking reads
  // turns one actionable extension error into an unusable workspace shell.
  // Mutations still fail closed on the same authoritative apply operation.
  if (method === "GET" || method === "HEAD") return "skip"
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

/**
 * The URL the embedded runtime sees for a dispatched request.
 *
 * This hop reuses the CALLER's origin rather than a synthetic one. The runtime
 * derives real behaviour from this URL — PTY creation reads its port via
 * `requestPort` and injects it as `CLAXEDO_PORT` / `CLAXEDO_SERVER_PORT`, which
 * is where terminal agent hooks post their lifecycle events. Dispatching from a
 * synthetic `http://embedded-workspace-runtime.local` (no port) made
 * `requestPort` fall through to the http default, so every terminal was told
 * the server lived on port 80: `notify.sh` posted to
 * `http://127.0.0.1:80/api/wr/hook/agent-lifecycle`, got nothing, and — because
 * it backgrounds its curl and discards the response — failed silently. The
 * symptom was a coding agent in a terminal that never showed working/permission
 * status, with no error anywhere. Verified by spawning a PTY that printed its
 * own env: `CLAXEDO_PORT=[80]` against a server on 3001.
 *
 * The synthetic host only ever bought a recognisable marker in traces, and
 * nothing routes on it. Fabricating an origin for a request that HAS one just
 * invents values the runtime then trusts, so the in-process hop is identified
 * by the `x-workspace-id` / `x-opencode-directory` headers set below instead.
 * (The other synthetic-base call sites construct requests with no caller at
 * all, so they legitimately need one.)
 */
export function embeddedRuntimeTargetUrl(requestUrl: URL, targetPath: string): URL {
  return new URL(targetPath + requestUrl.search, requestUrl)
}

export async function embedded(c: Context, ws: NonNullable<Awaited<ReturnType<typeof resolveWorkspace>>>, pathname?: string) {
  const url = new URL(c.req.url)
  const targetPath = pathname ?? url.pathname
  const runtime = await ensureEmbeddedWorkspaceRuntime(ws, { config: embeddedConfigModeForPath(targetPath, c.req.method) })
  const target = embeddedRuntimeTargetUrl(url, targetPath)
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
