import type { Context, Next } from "hono"
import { ensureWorkspaceRuntime, holdRuntime, markRuntimeUse, releaseRuntime, getSandbox } from "./workspace-supervisor"
import { resolveWorkspace } from "./workspace-store"
import { opencodeHeaders } from "./opencode-auth"
import { resolveRunnerHostForRequest } from "./runner-resolution"

function matches(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(prefix + "/"))
}

const WR_INTERNAL = ["/api/wr/health", "/api/wr/config", "/api/wr/acp-config-options", "/api/wr/capabilities"]

const WR_ALWAYS_PREFIXES = [
  "/api/claxedo/process",
  "/api/claxedo/diff",
  "/find",
]

const WR_HARNESS_PREFIXES = [
  "/session",
  "/permission",
  "/question",
  "/event",
  "/mcp",
]

const WR_ALWAYS_PATHS = [
  "/file",
  "/file/all",
  "/file/content",
  "/file/status",
]

const WR_HARNESS_PATHS = [
  "/agent",
  "/command",
  "/lsp",
  "/vcs",
]

const CS_PATHS = [
  "/global/event",
  "/global/health",
  "/path",
  "/config",
  "/global/config",
  "/api/claxedo/health",
  "/api/claxedo/track",
  "/api/claxedo/events",
  "/api/claxedo/bootstrap",
]

const CS_PREFIXES = [
  "/provider",
  "/project",
  "/experimental",
  "/api/claxedo/agent-config",
  "/api/claxedo/session",
  "/api/claxedo/hook",
  "/api/claxedo/pty",
  "/pages",
  "/api/workgraph",
]

type Hit = {
  workspaceId: string
  workspaceName?: string
  directory: string
  url: string
}

// Cloud runtime startup can legitimately take minutes on cold sandboxes
// while clone/install/health checks complete. Keep this proxy timeout above
// the runtime's own startup budget so early requests don't fail with a false
// "workspace runtime unavailable" while provisioning is still in progress.
const RUNTIME_WAIT_MS = 10 * 60_000

function requestWorkspace(c: Context) {
  const dir = c.req.query("directory") || c.req.header("x-opencode-directory")
  return {
    workspaceId: c.req.query("workspaceId") || c.req.query("workspace") || c.req.header("x-workspace-id"),
    directory: dir ? decodeURIComponent(dir) : undefined,
  }
}

async function resolveRuntime(c: Context): Promise<Hit | undefined> {
  const input = requestWorkspace(c)
  const ws = await resolveWorkspace({
    workspaceId: input.workspaceId,
    directory: input.directory,
  })
  if (!ws) return
  if (ws.kind !== "cloud") return
  const pending = ensureWorkspaceRuntime(ws.id)
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
    directory: ws.remote_directory || ws.directory,
    url: runtime.url!,
  }
}

function requestSessionId(c: Context) {
  const hit = c.req.query("sessionId") || c.req.query("session") || c.req.header("x-session-id")
  if (hit) return hit
  const pathname = new URL(c.req.url).pathname
  const match = pathname.match(/^\/session\/([^/]+)/)
  return match?.[1]
}

function noWr(c: Context, err?: unknown) {
  const input = requestWorkspace(c)
  const msg = err instanceof Error ? err.message : undefined
  return c.json(
    {
      error: "workspace runtime unavailable",
      ...(msg ? { detail: msg } : {}),
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

async function proxy(c: Context, hit: Hit) {
  const url = new URL(c.req.url)
  const target = new URL(url.pathname + url.search, hit.url)
  // Rewrite directory query param to the remote directory
  if (target.searchParams.has("directory")) {
    target.searchParams.set("directory", hit.directory)
  }
  const headers = opencodeHeaders(c.req.raw.headers)
  headers.set("x-workspace-id", hit.workspaceId)
  if (hit.workspaceName) headers.set("x-workspace-name", hit.workspaceName)
  headers.set("x-opencode-directory", hit.directory)
  headers.set("X-Daytona-Skip-Preview-Warning", "true")
  headers.delete("host")
  headers.delete("connection")
  // Prevent the upstream from compressing responses. Node's fetch (undici)
  // auto-decompresses, but the Daytona proxy layer can produce responses
  // where the content-encoding header and actual body encoding disagree,
  // causing Z_DATA_ERROR (incorrect header check) during decompression.
  // Requesting identity encoding avoids the mismatch entirely.
  headers.set("accept-encoding", "identity")

  const req = new Request(target.toString(), {
    method: c.req.method,
    headers,
    body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
    // @ts-ignore
    duplex: "half",
  })

  const res = await fetch(req)
  markRuntimeUse(hit.workspaceId)
  getSandbox(hit.workspaceId)?.refreshActivity().catch(() => {})
  if (!res.body || !streaming(url.pathname, res.headers)) {
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  }

  holdRuntime(hit.workspaceId)
  const reader = res.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const next = await reader.read()
      if (next.done) {
        releaseRuntime(hit.workspaceId)
        ctrl.close()
        return
      }
      ctrl.enqueue(next.value)
    },
    async cancel(reason) {
      releaseRuntime(hit.workspaceId)
      await reader.cancel(reason)
    },
  })

  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

export async function workspaceRuntimeProxy(c: Context, next: Next): Promise<Response | void> {
  const pathname = new URL(c.req.url).pathname

  if (CS_PATHS.includes(pathname) || matches(pathname, CS_PREFIXES)) {
    return next()
  }

  const internal = WR_INTERNAL.includes(pathname)
  const always = WR_ALWAYS_PATHS.includes(pathname) || matches(pathname, WR_ALWAYS_PREFIXES)
  const harness = WR_HARNESS_PATHS.includes(pathname) || matches(pathname, WR_HARNESS_PREFIXES)

  if (!internal && !always && !harness) {
    return next()
  }

  if (harness) {
    const host = await resolveRunnerHostForRequest({
      type: c.req.query("runner") || c.req.header("x-claxedo-runner"),
      binary: c.req.header("x-claxedo-binary"),
      model: c.req.header("x-claxedo-model"),
      sessionId: requestSessionId(c),
      workspaceId: c.req.query("workspaceId") || c.req.query("workspace") || c.req.header("x-workspace-id"),
      directory: c.req.query("directory") || c.req.header("x-opencode-directory"),
    })
    if (host === "central") return next()
  }

  try {
    const hit = await resolveRuntime(c)
    if (!hit) return next()
    return await proxy(c, hit)
  } catch (err) {
    return noWr(c, err)
  }
}
