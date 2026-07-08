import type { Hono } from "hono"
import { PtyRoutes } from "../routes/pty"
import { AgentHookRoutes } from "../routes/agent-hook"
import { runtimeEventsHandler } from "../routes/events"
import { runtimeBusEventsHandler } from "../routes/runtime-events"
import { ProcessRoutes } from "../routes/process"
import { DiffRoutes } from "../routes/diff"
import { FileRoutes } from "../routes/file"
import { GitSourceRoutes } from "../routes/git-source"
import type { RuntimeEventHub } from "../runtime-event-hub"
import { WorkspaceRuntimeApiPrefix, WorkspaceRuntimeRoutes } from "../routes/manifest"
import { assertWorkspaceRuntimeExposure, type WorkspaceRuntimeExposure } from "../exposure"

type Socket = Parameters<typeof PtyRoutes>[0]

export function mountWorkspacePty(app: Hono, upgradeWebSocket: Socket) {
  app.route(WorkspaceRuntimeRoutes.pty, PtyRoutes(upgradeWebSocket))
}

export function mountWorkspaceAgentHooks(app: Hono) {
  app.route(WorkspaceRuntimeRoutes.hook, AgentHookRoutes())
}

export function mountWorkspaceEvents(app: Hono, options: { eventHub: RuntimeEventHub }) {
  app.get(WorkspaceRuntimeRoutes.events, runtimeBusEventsHandler())
  app.get(WorkspaceRuntimeRoutes.runtimeEvents, runtimeEventsHandler(options.eventHub))
}

export function mountWorkspaceProcess(app: Hono) {
  app.route(WorkspaceRuntimeRoutes.process, ProcessRoutes())
}

export function mountWorkspaceFiles(app: Hono) {
  app.route(WorkspaceRuntimeRoutes.diff, DiffRoutes())
  app.route(WorkspaceRuntimeRoutes.git, GitSourceRoutes())
  app.route(WorkspaceRuntimeApiPrefix, FileRoutes())
  // OpenCode-compatible adapter routes. The neutral public runtime API is
  // mounted above under /api/wr.
  app.route("/", FileRoutes())
}

export function mountWorkspaceCore(
  app: Hono,
  upgradeWebSocket: Socket,
  options: { eventHub: RuntimeEventHub; exposure: WorkspaceRuntimeExposure },
) {
  assertWorkspaceRuntimeExposure({ exposure: options.exposure, env: process.env })
  mountWorkspacePty(app, upgradeWebSocket)
  mountWorkspaceAgentHooks(app)
  mountWorkspaceEvents(app, options)
  mountWorkspaceProcess(app)
  mountWorkspaceFiles(app)
}
