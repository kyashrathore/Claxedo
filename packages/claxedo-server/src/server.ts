import { Hono } from "hono"
import { cors } from "hono/cors"
import { serve } from "@hono/node-server"
import { createNodeWebSocket } from "@hono/node-ws"
import { z } from "zod"
import path from "path"
import Database from "better-sqlite3"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { AgentHookRoutes, ProcessRoutes, PtyRoutes, setupAgentHooks } from "../../workspace-runtime/src"
import type { Hono as HonoType } from "hono"

/**
 * Mount a sub-app from workspace-runtime which may resolve a different Hono
 * version (4.10 vs 4.12).  The types are structurally compatible at runtime;
 * this helper confines the version-bridge cast to a single site.
 */
function mount(parent: HonoType, path: string, sub: { fetch: (...args: never[]) => Response | Promise<Response> }) {
  parent.route(path, sub as unknown as HonoType)
}

const execFileAsync = promisify(execFile)
import { capture, initPostHog, shutdownPostHog } from "./posthog"
import { eventsHandler, globalEventsHandler } from "./routes/events"
import { mirrorProcessEvents } from "./process-events"
import { PagesRoutes } from "./routes/pages"
import { AgentConfigRoutes } from "./routes/agent-config"
import { AgentSessionRoutes } from "./routes/agent-session"
import { SessionMetaRoutes } from "./routes/session-meta"
import { WorkspaceRoutes } from "./routes/workspace"
import { DiffRoutes } from "./routes/diff"
import { TunnelRoutes } from "./routes/tunnel"
import { configureOpenCodeCompat, OpenCodeCompatRoutes } from "./routes/opencode-compat"
import { workspaceRuntimeProxy } from "./proxy"
import { createApp as createWorkGraphApp, initializeDb as initWorkGraphDb, resolveRepoDir } from "@opencode-ai/workgraph"
import { createWorkGraphExecution } from "./workgraph-execution"
import { createOpencodeEvents } from "./opencode-events"
import { globalBus } from "./bus"
import { dataDir } from "./paths"
import { configureWorkspaceSupervisor, shutdownWorkspaceSupervisor } from "./workspace-supervisor"
import { configureLocalAgentEngine, shutdownLocalAgentEngine } from "./local-agent-engine"
import { initPool, poolEnabled, startPoolMonitor, shutdown as shutdownPool } from "./cloud/sandbox"
import { configureOpenCodeAuth, opencodeHeaders } from "./opencode-auth"
import { configureHarnessMode, getHarnessMode, getSessionWriteMode, getWorkspaceProfile } from "./architecture"
import { createSyncDB } from "./sync-db"
import { configureHarnessHost } from "./harness/host"
import { createPiHost } from "./harness/pi-host"
import { migrateCredentials } from "./credentials/migrate"
import { CredentialRoutes } from "./routes/credential"
import { NetworkPolicyRoutes } from "./routes/network-policy"

const app = new Hono()
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

app.use(
  cors({
    origin: (origin) => {
      if (!origin) return undefined
      if (origin.startsWith("http://localhost:")) return origin
      if (origin.startsWith("http://127.0.0.1:")) return origin
      if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(origin)) return origin
      return undefined
    },
  }),
)

const TrackBody = z.object({
  distinctId: z.string(),
  event: z.string(),
  properties: z.record(z.string(), z.unknown()).optional(),
})

app.post("/api/claxedo/track", async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = TrackBody.safeParse(body)
  if (!parsed.success) return c.json({ error: "Invalid body" }, 400)
  capture(parsed.data.distinctId, parsed.data.event, parsed.data.properties)
  return c.json({ ok: true })
})

app.get("/api/claxedo/health", (c) =>
  c.json({
    ok: true,
    harnessMode: getHarnessMode(),
    workspaceProfile: getWorkspaceProfile(),
  }))

// Route cloud workspace traffic before route matching so later handlers only see local requests.
app.use(workspaceRuntimeProxy)

// OpenCode-compat routes (provider, config, project, session, agent, command)
app.route("/", OpenCodeCompatRoutes())

// Global compat event stream is aggregated by the control plane.
app.get("/global/event", globalEventsHandler)

// Local agent routes are handled in-process for local workspaces.
mount(app, "/", AgentSessionRoutes())

// Local workspace extras are handled in-process.
mount(app, "/api/claxedo/pty", PtyRoutes(upgradeWebSocket as unknown as Parameters<typeof PtyRoutes>[0]))
mount(app, "/api/claxedo/process", ProcessRoutes())
app.route("/api/claxedo/diff", DiffRoutes())
app.route("/api/claxedo/tunnel", TunnelRoutes())

// Claxedo events SSE
app.get("/api/claxedo/events", eventsHandler)

// Pages routes
app.route("/pages", PagesRoutes())

// Agent config routes (centralized MCP + commands management)
app.route("/api/claxedo/agent-config", AgentConfigRoutes())
app.route("/", SessionMetaRoutes())
app.route("/api/workspace", WorkspaceRoutes())
app.route("/api/claxedo/credentials", CredentialRoutes())
app.route("/api/claxedo/network-policy", NetworkPolicyRoutes())

// Agent hook routes (tab-context, terminal-session, agent-lifecycle, setup)
mount(app, "/api/claxedo/hook", AgentHookRoutes())

export function startServer(port = 3001, opencodeUrl = "http://127.0.0.1:4096", opencodePassword?: string | null) {
  process.env.OPENCODE_URL = opencodeUrl
  configureHarnessMode()
  const sync = createSyncDB({ mode: getSessionWriteMode })
  configureHarnessHost(createPiHost(sync))
  initPostHog()
  mirrorProcessEvents()
  configureOpenCodeAuth(opencodePassword)
  configureOpenCodeCompat(opencodeUrl)
  configureLocalAgentEngine(opencodeUrl)
  configureWorkspaceSupervisor({
    server_url: `http://127.0.0.1:${port}`,
    opencode_url: opencodeUrl,
  })

  // Migrate legacy plaintext credentials into the managed secret backend.
  migrateCredentials().catch((err) => {
    console.error("[claxedo-server] WARN  credential migration failed:", err)
  })

  // Persist message events from ALL workspaces (local + cloud) to claxedo DB.
  // Both local (agent-session publishGlobal) and cloud (workspace-supervisor streamGlobal)
  // events converge on globalBus — this is the single point of persistence.
  sync.subscribe_message_replay(globalBus)

  // Initialize warm sandbox pool only when Daytona is configured.
  poolEnabled()
    .then((enabled) => {
      if (!enabled) return
      initPool().catch((err) => {
        console.error("[claxedo-server] WARN  sandbox pool init failed:", err)
      })
      startPoolMonitor()
    })
    .catch((err) => {
      console.error("[claxedo-server] WARN  sandbox pool enablement check failed:", err)
    })

  // Connect through the claxedo-server proxy (not directly to opencode) so that in ACP
  // mode the events come from workspace-runtime's /global/event translation layer.
  const opencodeEvents = createOpencodeEvents(`http://127.0.0.1:${port}`)
  const upstreamEvents = createOpencodeEvents(opencodeUrl)

  upstreamEvents.on((event) => {
    if (!event.payload.type) return
    globalBus.publish({
      directory: event.directory ?? "global",
      payload: {
        type: event.payload.type,
        properties: event.payload.properties,
      },
    })
  })

  try {
    const workgraphDb = new Database(path.join(dataDir(), "workgraph.db"))
    initWorkGraphDb(workgraphDb)

    const workgraphApp = createWorkGraphApp(workgraphDb, {
      execution: createWorkGraphExecution(workgraphDb, opencodeUrl, opencodeEvents),
      auth: async (provider) => {
        if (provider !== "github") return null
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
          const res = await fetch(`${opencodeUrl}/project`, {
            headers: opencodeHeaders({ "x-opencode-directory": process.cwd() }),
          })
          if (!res.ok) return []
          const data = await res.json()
          const projects = Array.isArray(data) ? data : [data]
          const results = await Promise.all(
            projects
              .filter((p: Record<string, unknown>) => p?.id && p?.worktree)
              .map((item: Record<string, unknown>) =>
                resolveRepoDir(item.worktree as string, {
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

    app.route("/api/workgraph", workgraphApp)
  } catch (err) {
    console.error("[claxedo-server] WARN  workgraph init failed:", err)
  }

  const server = serve({
    fetch: app.fetch,
    port,
    hostname: "127.0.0.1",
  })
  injectWebSocket(server)

  // Initialize agent hooks (wrapper scripts, shell integration)
  setupAgentHooks({ port })
    .then(() => {
      console.error(`[claxedo-server] INFO  agent hooks setup complete`)
    })
    .catch((err) => {
      console.error(`[claxedo-server] WARN  failed to setup agent hooks`, err)
    })

  process.on("SIGTERM", async () => {
    opencodeEvents.close()
    upstreamEvents.close()
    shutdownPool()
    await shutdownLocalAgentEngine()
    await shutdownWorkspaceSupervisor()
    await shutdownPostHog()
    server.close()
    process.exit(0)
  })

  return server
}
