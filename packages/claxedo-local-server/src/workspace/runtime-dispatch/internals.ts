import type { Context } from "hono"
import { workspaceSupervisor } from "@claxedo/server-core/workspace/supervisor-port"
import type { SandboxEnsureResult, SandboxManagerPort } from "@claxedo/server-core/sandbox/manager-port"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { ensureEmbeddedWorkspaceRuntime, type EmbeddedWorkspaceRuntimeConfigMode } from "../../deployments/local/embedded-workspace-runtime"
import { routeOwnership, RouteHandler } from "@claxedo/server-core/platform/governance/route-ownership"
import { normalizeClaxedoRegion, type ClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import type { RelayProvider } from "@claxedo/server-core/adapters/relay/index"
import type { RuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import { errorBody } from "@claxedo/server-core/platform/http/http"
import { EMBEDDED_RELAY_HOST_AUTH_HEADER } from "./embedded-relay-host-auth"
import { resolveIngressProvenance } from "./ingress-provenance"

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
  resolveRelayActor?: (request: Request, workspaceId: string) => Promise<(RuntimeActor & {
    orgId: string
    role: "viewer" | "editor" | "admin" | "owner"
  }) | undefined>
  /** Signed deployments must never fall back to the synthetic local owner. */
  requireRelayActor?: boolean
  /** See `ingress-provenance.ts`: refuse a relayed request this host cannot place. */
  verifyRelayIngress?: boolean
  /**
   * Answers the host aggregate `wr/events`. Only the desktop-local
   * composition supplies one; without it a workspace-less request keeps
   * falling through as before.
   */
  hostEventStream?: (c: Context) => Response | Promise<Response>
}

const WR_EVENTS = "/api/wr/events"

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
  const dir = c.req.query("directory") || c.req.header("x-claxedo-directory")
  return {
    workspaceId: c.req.query("workspaceId") || c.req.query("workspace") || c.req.header("x-workspace-id"),
    directory: dir ? decodeURIComponent(dir) : undefined,
  }
}

/**
 * `/api/wr/events` naming no workspace is the HOST AGGREGATE: the daemon
 * hosts every local runtime in-process, so it is the one composition that can
 * serve them all on one connection. Returns `undefined` for anything else —
 * a workspace-scoped stream, another runtime-owned path, or a composition
 * that mounts no aggregate — leaving the request on the dispatch path it had
 * before, and synchronously, so nothing else on that path pays a turn of the
 * microtask queue for a question that was not about it.
 *
 * The aggregate asks no admission question and serves every workspace's
 * frames, which only a loopback-direct reader may have. Where a request came
 * from is `resolveIngressProvenance`'s question, asked here with no actor
 * resolver: a relay-minted token is bound to one workspace and this stream
 * spans them all, so there is nobody for it to promote and its refusals are
 * the whole answer. The workspace id it takes is never read without that
 * resolver, which is why this one is empty, and the refusals are asked for
 * whatever the composition declares, because a stream that spans every
 * workspace is exactly the thing a host serving two kinds of caller on one
 * listener must not hand to the wrong one.
 *
 * Two refusals remain this function's own: the in-process relay host-auth
 * stamp, which is the dispatch hop's output rather than anything a boundary
 * verified, so a request already placed as a relayed member is not this
 * stream's reader; and `?sessionID=`, which has no meaning on a stream that
 * spans workspaces — the reader opens that workspace's own stream for it.
 */
export function hostAggregateEvents(c: Context, pathname: string, options: RuntimeProxyOptions) {
  if (pathname !== WR_EVENTS || !options.hostEventStream) return undefined
  const named = requestWorkspace(c)
  if (named.workspaceId || named.directory) return undefined
  return decideHostAggregate(c, options, options.hostEventStream)
}

async function decideHostAggregate(
  c: Context,
  options: RuntimeProxyOptions,
  serve: NonNullable<RuntimeProxyOptions["hostEventStream"]>,
) {
  const provenance = await resolveIngressProvenance(c.req.raw, "", {
    ...(options.requireRelayActor ? { requireRelayActor: true } : {}),
    verifyRelayIngress: true,
  })
  if (provenance.kind !== "loopback-direct" || c.req.header(EMBEDDED_RELAY_HOST_AUTH_HEADER)) {
    return c.json(errorBody(
      "host_event_stream_denied",
      "The host event stream is served to loopback-direct readers only",
    ), 403)
  }
  if (c.req.query("sessionID")) {
    return c.json(errorBody(
      "host_event_stream_session_scoped",
      "The host event stream spans every workspace; open a workspace's own stream for a session",
    ), 400)
  }
  return serve(c)
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
  if (!ws) return undefined
  if (ws.kind !== "cloud") return undefined
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
  if (pathname === WR_EVENTS) return true
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
  resolveRelayActor?: RuntimeProxyOptions["resolveRelayActor"]
  requireRelayActor?: boolean
}) {
  const url = new URL(c.req.url)
  const target = await proxyTarget(hit, options, (options?.pathname ?? url.pathname) + url.search)
  const headers = new Headers(c.req.raw.headers)
  headers.set("x-workspace-id", hit.workspaceId)
  if (hit.workspaceName) headers.set("x-workspace-name", hit.workspaceName)
  headers.set("x-claxedo-directory", hit.relay ? `workspace:${hit.workspaceId}` : hit.directory)
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
  // SECURITY — actor-bearing signed traffic must resolve its caller before
  // this branch. Only explicit unsigned-local composition uses the separate
  // control-plane service principal.
  // `localWorkspaceRelayProxy` serves browser-originated traffic on a
  // loopback server URL (`workspace-runtime-request.ts:223`). The thing
  // standing between a local process and that unsigned owner-role token is
  // `isLoopbackLocalRequest` (`local-only-projection.ts`), checked at the top of
  // `localWorkspaceRelayProxyWithOptions` — it fails closed on forwarded
  // headers and verifies peer address, host, and origin. That gate is
  // load-bearing for this mint, not just for the local projections it was
  // written for: weakening it (e.g. trusting a forwarded client claim here)
  // hands out owner tokens. `localWorkspaceRelayProxy denies a forwarded-client
  // request before minting` in proxy.test.ts pins the ordering.
  if (hit.relay && options?.relayProvider) {
    const actor = requireRuntimeProxyActor(
      await options.resolveRelayActor?.(c.req.raw, hit.workspaceId),
      options.requireRelayActor === true,
    )
    const principal = actor
      ? {
          principalKind: actor.actorKind === "human" ? "user" as const : "service" as const,
          actorId: actor.actorId,
          actorKind: actor.actorKind,
          ...(actor.actorPublicId && actor.actorName
            ? {
                actorPublicId: actor.actorPublicId,
                actorName: actor.actorName,
                ...(actor.actorAvatarUrl ? { actorAvatarUrl: actor.actorAvatarUrl } : {}),
              }
            : {}),
          orgId: actor.orgId,
          role: actor.role,
        }
      : {
          principalKind: "service" as const,
          actorId: "control-plane",
          actorKind: "agent" as const,
          orgId: hit.relay.orgId,
          role: "owner" as const,
        }
    const token = await options.relayProvider.mintRuntimeAccessToken({
      workspaceId: hit.workspaceId,
      hostId: hit.relay.hostId,
      ...principal,
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
  const responseHeaders = runtimeProxyResponseHeaders(res.headers)
  const contentType = res.headers.get("content-type") ?? ""
  const streamResponse =
    streaming(url.pathname, res.headers) ||
    contentType.includes("application/octet-stream")
  if (!res.body || !streamResponse) {
    const body = res.body ? await res.arrayBuffer() : null
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: responseHeaders,
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

export function requireRuntimeProxyActor<T>(actor: T | undefined, required: boolean) {
  if (required && !actor) throw new Error("Signed runtime proxy requires a verified actor")
  return actor
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
    || pathname === WR_EVENTS
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
 * by the `x-workspace-id` / `x-claxedo-directory` headers set below instead.
 * (The other synthetic-base call sites construct requests with no caller at
 * all, so they legitimately need one.)
 */
export function embeddedRuntimeTargetUrl(requestUrl: URL, targetPath: string): URL {
  return new URL(targetPath + requestUrl.search, requestUrl)
}

export async function embedded(
  c: Context,
  ws: NonNullable<Awaited<ReturnType<typeof resolveWorkspace>>>,
  pathname?: string,
  options?: Pick<RuntimeProxyOptions, "resolveRelayActor" | "requireRelayActor" | "verifyRelayIngress">,
) {
  // Ahead of the runtime: a refused request must not start a workspace.
  const provenance = await resolveIngressProvenance(c.req.raw, ws.id, options)
  if (provenance.kind === "rejected") return provenance.response
  const url = new URL(c.req.url)
  const targetPath = pathname ?? url.pathname
  const runtime = await ensureEmbeddedWorkspaceRuntime(ws, { config: embeddedConfigModeForPath(targetPath, c.req.method) })
  const target = embeddedRuntimeTargetUrl(url, targetPath)
  if (target.searchParams.has("directory")) target.searchParams.set("directory", ws.directory)
  const headers = new Headers(c.req.raw.headers)
  headers.set("x-workspace-id", ws.id)
  headers.set("x-claxedo-directory", ws.directory)
  headers.delete("host")
  headers.delete("connection")
  // Never trust a client-supplied stamp; only this in-process hop may set it,
  // and only for the provenance it just verified. The runtime reads its
  // absence as the machine's own user.
  headers.delete(EMBEDDED_RELAY_HOST_AUTH_HEADER)
  if (provenance.kind === "relay-replayed") {
    headers.set(EMBEDDED_RELAY_HOST_AUTH_HEADER, JSON.stringify(provenance.stamp))
  }
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

