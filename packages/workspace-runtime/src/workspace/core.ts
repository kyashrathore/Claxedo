import type { AgentSessionStarts } from "@claxedo/agent-runtime-contract"
import type { LaunchOwnershipStore } from "@claxedo/agent-sdk-runtime/launch"
import type { Hono } from "hono"
import { PtyRoutes, type PtyRouteOptions } from "../routes/pty"
import { Pty } from "../pty/index"
import { AgentHookRoutes } from "../routes/agent-hook"
import { workspaceEventsHandler, type WorkspaceEventFramesTap, type WorkspaceEventParents } from "../routes/events"
import { TranscriptRoutes } from "../routes/transcript"
import type { TranscriptResolution, TranscriptUnavailable } from "../transcript-resolver"
import { ProcessRoutes, type ProcessRouteOptions } from "../routes/process"
import { createDiffRoutes } from "../routes/diff"
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

export type MountedWorkspaceEvents = {
  close: () => void
  frames: WorkspaceEventFramesTap
}

export function mountWorkspacePty(
  app: Hono,
  upgradeWebSocket: Socket,
  processObserver?: ProcessObserver,
  sessionAccessPolicy?: SessionAccessPolicy,
  options?: PtyRouteOptions,
) {
  app.route(WorkspaceRuntimeRoutes.pty, PtyRoutes(upgradeWebSocket, processObserver, sessionAccessPolicy, options))
}

export function mountWorkspaceAgentHooks(app: Hono, sessionAccessPolicy?: SessionAccessPolicy) {
  app.route(WorkspaceRuntimeRoutes.hook, AgentHookRoutes({ sessionAccessPolicy }))
}

/**
 * Mounts the workspace's stream. `close` releases its bus subscription;
 * `frames` is the same subscriptions' frames, for a host that serves several
 * runtimes on one stream of its own.
 */
export function mountWorkspaceEvents(app: Hono, options: {
  directory: string
  workspaceId?: string
  eventHub: RuntimeEventHub
  sessionParents?: WorkspaceEventParents
  sessionStarts?: Pick<AgentSessionStarts, "get">
  sessionAccessPolicy?: SessionAccessPolicy
  /** The delivery policy's renewal cadence; a test shortens it to watch a lease lapse. */
  renewalIntervalMs?: number
}): MountedWorkspaceEvents {
  const policy = sessionEventDeliveryPolicy(options.sessionAccessPolicy ?? managedWorkspaceSessionAccessPolicy())
  const handler = workspaceEventsHandler({
    directory: options.directory,
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    eventHub: options.eventHub,
    ptyDirectory: (id) => Pty.get(id)?.cwd,
    policy,
    sessionAccessPolicy: options.sessionAccessPolicy,
    sessionStarts: options.sessionStarts,
    ...(options.sessionParents ? { sessionParents: options.sessionParents } : {}),
    ...(options.renewalIntervalMs !== undefined ? { renewalIntervalMs: options.renewalIntervalMs } : {}),
  })
  app.get(WorkspaceRuntimeRoutes.events, handler)
  return { close: handler.close, frames: handler.frames }
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

export function mountWorkspaceProcess(app: Hono, sessionAccessPolicy?: SessionAccessPolicy, options?: ProcessRouteOptions) {
  app.route(WorkspaceRuntimeRoutes.process, ProcessRoutes(sessionAccessPolicy, options))
}

export function mountWorkspaceFiles(app: Hono, sessionAccessPolicy?: SessionAccessPolicy) {
  // Every family here takes a directory, and a registered per-session worktree
  // is one of the directories this runtime serves: the policy is what decides
  // whether the caller may read or write the session that owns it.
  const access = sessionAccessPolicy ? { sessionAccessPolicy } : {}
  app.route(WorkspaceRuntimeRoutes.diff, createDiffRoutes({}, access))
  app.route(WorkspaceRuntimeRoutes.git, GitSourceRoutes(access))
  app.route(WorkspaceRuntimeRoutes.git, GitWorktreeRoutes(access))
  app.route(WorkspaceRuntimeApiPrefix, FileRoutes(access))
  // Claxedo client-presentation adapter routes. The neutral public runtime API is
  // mounted above under /api/wr.
  app.route("/", FileRoutes(access))
}

export function mountWorkspaceCore(
  app: Hono,
  upgradeWebSocket: Socket,
  options: {
    directory: string
    workspaceId?: string
    eventHub: RuntimeEventHub
    exposure: WorkspaceRuntimeExposure
    processObserver?: ProcessObserver
    sessionParents?: WorkspaceEventParents
    sessionStarts?: Pick<AgentSessionStarts, "get">
    sessionAccessPolicy?: SessionAccessPolicy
    transcripts?: WorkspaceTranscriptRoutesOptions
    /** Resolved per launch, not captured: one process serves many workspaces. */
    launchOwnership?: () => LaunchOwnershipStore
  },
): MountedWorkspaceEvents {
  assertWorkspaceRuntimeExposure({ exposure: options.exposure, env: process.env })
  const ownership = options.launchOwnership ? { ownership: options.launchOwnership } : {}
  mountWorkspacePty(app, upgradeWebSocket, options.processObserver, options.sessionAccessPolicy, ownership)
  mountWorkspaceAgentHooks(app, options.sessionAccessPolicy)
  const events = mountWorkspaceEvents(app, options)
  if (options.transcripts) mountWorkspaceTranscripts(app, options.transcripts)
  mountWorkspaceProcess(app, options.sessionAccessPolicy, ownership)
  mountWorkspaceFiles(app, options.sessionAccessPolicy)
  return events
}
