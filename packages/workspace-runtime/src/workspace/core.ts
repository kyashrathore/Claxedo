import type { Hono } from "hono"
import { PtyRoutes } from "../routes/pty"
import { AgentHookRoutes } from "../routes/agent-hook"
import { runtimeEventsHandler } from "../routes/events"
import type { RuntimeEventAuthorization } from "../routes/events"
import { TranscriptRoutes } from "../routes/transcript"
import type { TranscriptResolution, TranscriptUnavailable } from "../transcript-resolver"
import { runtimeBusEventsHandler } from "../routes/runtime-events"
import { ProcessRoutes } from "../routes/process"
import { DiffRoutes } from "../routes/diff"
import { FileRoutes } from "../routes/file"
import { GitSourceRoutes } from "../routes/git-source"
import type { RuntimeEventHub } from "../runtime-event-hub"
import { WorkspaceRuntimeApiPrefix, WorkspaceRuntimeRoutes } from "../routes/manifest"
import { assertWorkspaceRuntimeExposure, type WorkspaceRuntimeExposure } from "../exposure"
import type { ProcessObserver } from "../managed-processes/process-observer"

type Socket = Parameters<typeof PtyRoutes>[0]

export function mountWorkspacePty(app: Hono, upgradeWebSocket: Socket, processObserver?: ProcessObserver) {
  app.route(WorkspaceRuntimeRoutes.pty, PtyRoutes(upgradeWebSocket, processObserver))
}

export function mountWorkspaceAgentHooks(app: Hono) {
  app.route(WorkspaceRuntimeRoutes.hook, AgentHookRoutes())
}

export function mountWorkspaceEvents(app: Hono, options: {
  eventHub: RuntimeEventHub
  runtimeEventAuthorization?: RuntimeEventAuthorization
}) {
  app.get(WorkspaceRuntimeRoutes.events, runtimeBusEventsHandler())
  app.get(WorkspaceRuntimeRoutes.runtimeEvents, runtimeEventsHandler(options.eventHub, options.runtimeEventAuthorization))
}

export type WorkspaceTranscriptRoutesOptions = {
  workspaceId: string
  resolver: {
    open(input: { workspaceId: string; parentSessionId: string; handle: string }): Promise<TranscriptResolution>
    register?(input: {
      workspaceId: string
      parentSessionId: string
      providerKind: string
      filePath: string
    }): Promise<{ state: "ready"; handle: string } | TranscriptUnavailable>
    invalidateParent?(workspaceId: string, parentSessionId: string): void
  }
}

export function mountWorkspaceTranscripts(app: Hono, options: WorkspaceTranscriptRoutesOptions) {
  app.route(WorkspaceRuntimeRoutes.subagentTranscripts, TranscriptRoutes(options))
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
  options: {
    eventHub: RuntimeEventHub
    exposure: WorkspaceRuntimeExposure
    processObserver?: ProcessObserver
    runtimeEventAuthorization?: RuntimeEventAuthorization
    transcripts?: WorkspaceTranscriptRoutesOptions
  },
) {
  assertWorkspaceRuntimeExposure({ exposure: options.exposure, env: process.env })
  mountWorkspacePty(app, upgradeWebSocket, options.processObserver)
  mountWorkspaceAgentHooks(app)
  mountWorkspaceEvents(app, options)
  if (options.transcripts) mountWorkspaceTranscripts(app, options.transcripts)
  mountWorkspaceProcess(app)
  mountWorkspaceFiles(app)
}
