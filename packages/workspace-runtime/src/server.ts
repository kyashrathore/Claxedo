import { Hono } from "hono"
import { cors } from "hono/cors"
import { serve } from "@hono/node-server"
import { createNodeWebSocket } from "@hono/node-ws"
import { Pty } from "./pty/index"
import * as ProcessManager from "./process/index"
import { workspaceDir, workspaceId } from "./target"
import { workspaceCapabilities } from "./capabilities"
import { profileFromEnv, type WorkspaceProfile } from "./profile"
import { createWorkspaceFullHost, createWorkspaceMinimalHost, mountWorkspaceCore } from "./workspace"
import { setupAgentHooks } from "./agent-hooks"

export function startServer(port = 3002, input?: { profile?: WorkspaceProfile }) {
  const profile = input?.profile ?? profileFromEnv(process.env)
  const caps = workspaceCapabilities(profile)
  const host = profile === "full" ? createWorkspaceFullHost() : createWorkspaceMinimalHost()

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

  app.get("/api/wr/health", (c) =>
    c.json((() => {
      const dir = workspaceDir()
      const rows = ProcessManager.list(dir)
      const detail = host.detail()
      return {
        ok: detail.state === "ready",
        status: detail.state,
        service: "workspace-runtime",
        workspaceId: workspaceId(),
        directory: dir,
        profile,
        capabilities: caps,
        agentType: detail.runner.type,
        acpBinary: detail.runner.type === "opencode" ? null : detail.runner.binary ?? null,
        model: detail.runner.model ?? null,
        error: detail.error || null,
        ptyCount: Pty.list().length,
        processCount: rows.length,
        activeProcessCount: rows.filter((item) => item.status !== "idle" && item.status !== "stopped").length,
      }
    })()),
  )

  mountWorkspaceCore(app, upgradeWebSocket, profile)
  app.get("/global/health", (c) => c.json({ healthy: host.detail().state === "ready", service: "workspace-runtime" }))
  host.mount(app)

  const server = serve({
    fetch: app.fetch,
    port,
    hostname: "127.0.0.1",
  })
  injectWebSocket(server)

  setupAgentHooks({ port })
    .then(() => {
      console.error(`[workspace-runtime] INFO  agent hooks setup complete`)
    })
    .catch((cause: unknown) => {
      console.error(`[workspace-runtime] WARN  failed to setup agent hooks`, cause)
    })

  process.on("SIGTERM", () => {
    host.dispose()
    server.close()
    process.exit(0)
  })

  return server
}
