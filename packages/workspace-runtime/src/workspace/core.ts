import type { Hono } from "hono"
import { PtyRoutes } from "../routes/pty"
import { AgentHookRoutes } from "../routes/agent-hook"
import { eventsHandler } from "../routes/events"
import { ProcessRoutes } from "../routes/process"
import { DiffRoutes } from "../routes/diff"
import { FileRoutes } from "../routes/file"
import type { WorkspaceCapabilities } from "../capabilities"
import { workspaceCapabilities } from "../capabilities"
import type { WorkspaceProfile } from "../profile"

type Socket = Parameters<typeof PtyRoutes>[0]

export function capabilities(profile: WorkspaceProfile): WorkspaceCapabilities {
  return workspaceCapabilities(profile)
}

export function mountWorkspaceCore(
  app: Hono,
  upgradeWebSocket: Socket,
  profile: WorkspaceProfile,
) {
  app.get("/api/wr/capabilities", (c) => c.json(capabilities(profile)))
  app.route("/api/claxedo/pty", PtyRoutes(upgradeWebSocket))
  app.route("/api/claxedo/hook", AgentHookRoutes())
  app.get("/api/claxedo/events", eventsHandler)
  app.route("/api/claxedo/process", ProcessRoutes())
  app.route("/api/claxedo/diff", DiffRoutes())
  app.route("/", FileRoutes())
}
