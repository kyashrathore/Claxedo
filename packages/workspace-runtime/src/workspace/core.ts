import type { Hono } from "hono"
import { PtyRoutes } from "../routes/pty"
import { AgentHookRoutes } from "../routes/agent-hook"
import { eventsHandler } from "../routes/events"
import { ProcessRoutes } from "../routes/process"
import { DiffRoutes } from "../routes/diff"
import { FileRoutes } from "../routes/file"

type Socket = Parameters<typeof PtyRoutes>[0]

export function mountWorkspaceCore(
  app: Hono,
  upgradeWebSocket: Socket,
) {
  app.route("/api/claxedo/pty", PtyRoutes(upgradeWebSocket))
  app.route("/api/claxedo/hook", AgentHookRoutes())
  app.get("/api/claxedo/events", eventsHandler)
  app.route("/api/claxedo/process", ProcessRoutes())
  app.route("/api/claxedo/diff", DiffRoutes())
  app.route("/", FileRoutes())
}
