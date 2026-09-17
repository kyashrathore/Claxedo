import type { Hono } from "hono"
import { PtyRoutes } from "../routes/pty"
import { Pty } from "../pty/index"
import { AgentHookRoutes } from "../routes/agent-hook"
import { workspaceEventsHandler, type WorkspaceEventParents } from "../routes/events"
import { TranscriptRoutes } from "../routes/transcript"
import type { TranscriptResolution, TranscriptUnavailable } from "../transcript-resolver"
import { ProcessRoutes } from "../routes/process"
import { DiffRoutes } from "../routes/diff"
import { FileRoutes } from "../routes/file"
import { GitSourceRoutes } from "../routes/git-source"
import { GitWorktreeRoutes } from "../routes/git-worktree"
import type { RuntimeEventHub } from "../runtime-event-hub"
import { WorkspaceRuntimeApiPrefix, WorkspaceRuntimeRoutes } from "../routes/manifest"
import { assertWorkspaceRuntimeExposure, type WorkspaceRuntimeExposure } from "../exposure"
import type { ProcessObserver } from "../managed-processes/process-observer"
import { sessionEventDeliveryPolicy } from "../event-delivery"
import { managedWorkspaceSessionAccessPolicy, type SessionAccessPolicy } from "../session-access-policy"

type Socket = Parameters<typeof PtyRoutes>[0]

export function mountWorkspacePty(
  app: Hono,
  upgradeWebSocket: Socket,
  processObserver?: ProcessObserver,
  sessionAccessPolicy?: SessionAccessPolicy,
) {
  app.route(WorkspaceRuntimeRoutes.pty, PtyRoutes(upgradeWebSocket, processObserver, sessionAccessPolicy))
}

export function mountWorkspaceAgentHooks(app: Hono, sessionAccessPolicy?: SessionAccessPolicy) {
  app.route(WorkspaceRuntimeRoutes.hook, AgentHookRoutes({ sessionAccessPolicy }))
}

/** Mounts the workspace's stream; the returned disposer releases its bus subscription. */
export function mountWorkspaceEvents(app: Hono, options: {
  directory: string
  eventHub: RuntimeEventHub
  sessionParents?: WorkspaceEventParents
  sessionAccessPolicy?: SessionAccessPolicy
}): () => void {
  const policy = sessionEventDeliveryPolicy(options.sessionAccessPolicy ?? managedWorkspaceSessionAccessPolicy())
  const handler = workspaceEventsHandler({
    directory: options.directory,
    eventHub: options.eventHub,
    ptyDirectory: (id) => Pty.get(id)?.cwd,
    policy,
    sessionAccessPolicy: options.sessionAccessPolicy,
    ...(options.sessionParents ? { sessionParents: options.sessionParents } : {}),
  })
  app.get(WorkspaceRuntimeRoutes.events, handler)
  return handler.close
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

export function mountWorkspaceProcess(app: Hono, sessionAccessPolicy?: SessionAccessPolicy) {
  app.route(WorkspaceRuntimeRoutes.process, ProcessRoutes(sessionAccessPolicy))
}

export function mountWorkspaceFiles(app: Hono, _sessionAccessPolicy?: SessionAccessPolicy) {
  app.route(WorkspaceRuntimeRoutes.diff, DiffRoutes())
  app.route(WorkspaceRuntimeRoutes.git, GitSourceRoutes())
  app.route(WorkspaceRuntimeRoutes.git, GitWorktreeRoutes())
  app.route(WorkspaceRuntimeApiPrefix, FileRoutes())
  // Claxedo client-presentation adapter routes. The neutral public runtime API is
  // mounted above under /api/wr.
  app.route("/", FileRoutes())
}

export function mountWorkspaceCore(
  app: Hono,
  upgradeWebSocket: Socket,
  options: {
    directory: string
    eventHub: RuntimeEventHub
    exposure: WorkspaceRuntimeExposure
    processObserver?: ProcessObserver
    sessionParents?: WorkspaceEventParents
    sessionAccessPolicy?: SessionAccessPolicy
    transcripts?: WorkspaceTranscriptRoutesOptions
  },
) {
  assertWorkspaceRuntimeExposure({ exposure: options.exposure, env: process.env })
  mountWorkspacePty(app, upgradeWebSocket, options.processObserver, options.sessionAccessPolicy)
  mountWorkspaceAgentHooks(app, options.sessionAccessPolicy)
  const closeEvents = mountWorkspaceEvents(app, options)
  if (options.transcripts) mountWorkspaceTranscripts(app, options.transcripts)
  mountWorkspaceProcess(app, options.sessionAccessPolicy)
  mountWorkspaceFiles(app)
  return closeEvents
}
