import path from "path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { Hono as HonoType } from "hono"
import type { ConnectionsService } from "@claxedo/connections"
import type { OpenCodeRequestFn } from "@claxedo/agent-sdk-runtime/adapters"
import { OPENCODE_INTERNAL_BASE } from "./opencode-engine"
import type { OpencodeEventsHandle } from "./opencode-events"
import { dataDir } from "./paths"
import { localOnlyProjection } from "./routes/local-only-projection"

const execFileAsync = promisify(execFile)

type WorkGraphRouteOptions = Omit<Parameters<typeof localOnlyProjection>[0], "label">

type FetchApp = {
  fetch: (request: Request) => Response | Promise<Response>
}

function workgraphRequest(request: Request) {
  const url = new URL(request.url)
  url.pathname = url.pathname === "/api/workgraph"
    ? "/"
    : url.pathname.slice("/api/workgraph".length)
  return new Request(url, request)
}

export function mountLazyLocalOnlyWorkGraph(
  app: HonoType,
  options: WorkGraphRouteOptions,
  load: () => Promise<FetchApp>,
) {
  let loaded: Promise<FetchApp> | undefined

  app.use("/api/workgraph", localOnlyProjection({
    ...options,
    label: "WorkGraph",
  }))
  app.use("/api/workgraph/*", localOnlyProjection({
    ...options,
    label: "WorkGraph",
  }))
  app.all("/api/workgraph", async (c) => (loaded ??= load()).then((next) => next.fetch(workgraphRequest(c.req.raw))))
  app.all("/api/workgraph/*", async (c) => (loaded ??= load()).then((next) => next.fetch(workgraphRequest(c.req.raw))))
}

export function mountLocalOnlyWorkGraph(app: HonoType, workgraphApp: HonoType, options: WorkGraphRouteOptions) {
  mountLazyLocalOnlyWorkGraph(app, options, async () => workgraphApp)
}

/**
 * Resolve a GitHub token through the @claxedo/connections framework
 * (one connections layer, no parallel auths). Tries the "work-source"
 * capability first (the capability workgraph connectors ride on), then
 * "code-host" (what the github integration declares today). Returns null
 * when no usable connection exists so callers can fall back.
 */
async function githubAuthFromConnections(connections: ConnectionsService | undefined) {
  if (!connections) return null
  for (const capability of ["work-source", "code-host"] as const) {
    try {
      // WorkGraph runs out of band from an interactive user turn, so it is
      // permanently constrained to the team partition.
      const [handle] = await connections.forCapability(capability, { integration: "github", scope: "team" })
      if (!handle) continue
      const { token } = await handle.getToken()
      if (!token) continue
      return {
        source: "connections" as const,
        token,
        name: handle.accountLabel ? `GitHub (${handle.accountLabel})` : "GitHub connection",
      }
    } catch {
      // Broken/degraded credential — keep trying other capabilities, then CLI.
    }
  }
  return null
}

export async function loadWorkGraphApp(input: {
  opencodeRequest: OpenCodeRequestFn
  opencodeEvents: OpencodeEventsHandle
  /**
   * Optional @claxedo/connections service. When present, github tokens are
   * resolved through it FIRST (capability handles, rotation-safe), before
   * falling back to the local `gh` CLI. The host should pass
   * `createApp(...)` result's `connections` (the connections-host service).
   */
  connections?: ConnectionsService
}) {
  const [
    sqlite,
    workgraph,
    execution,
  ] = await Promise.all([
    import("better-sqlite3"),
    import("@claxedo/workgraph"),
    import("./workgraph-execution"),
  ])
  const Database = sqlite.default
  const workgraphDb = new Database(path.join(dataDir(), "workgraph.db"))
  workgraph.initializeDb(workgraphDb)

  return workgraph.createApp(workgraphDb, {
    execution: execution.createWorkGraphExecution(workgraphDb, input.opencodeRequest, input.opencodeEvents),
    auth: async (provider) => {
      if (provider !== "github") return null
      const viaConnections = await githubAuthFromConnections(input.connections)
      if (viaConnections) return viaConnections
      try {
        const { stdout } = await execFileAsync("gh", ["auth", "token"])
        const token = stdout.trim()
        if (!token) return null
        return { source: "github_cli" as const, token, name: "GitHub CLI" }
      } catch {
        return null
      }
    },
    repos: async () => {
      try {
        const res = await input.opencodeRequest(new Request(`${OPENCODE_INTERNAL_BASE}/project`, {
          headers: { "x-opencode-directory": process.cwd() },
        }))
        if (!res.ok) return []
        const data = await res.json()
        const projects = Array.isArray(data) ? data : [data]
        const results = await Promise.all(
          projects
            .filter((p: Record<string, unknown>) => p?.id && p?.worktree)
            .map((item: Record<string, unknown>) =>
              workgraph.resolveRepoDir(item.worktree as string, {
                project_id: item.id as string,
                project_name: (item.name as string) ?? null,
              }).catch(() => null),
            ),
        )
        return results.filter((item): item is Exclude<typeof item, null> => !!item)
      } catch {
        return []
      }
    },
  })
}
