import { isAgentMessage, renderSessionHandoff, type AgentMessage, type SessionHarness } from "@claxedo/agent-sdk-runtime"
import { asRecord, isRecord } from "@claxedo/helpers/guards"
import {
  TasksError,
  hashRequest,
  startDigest,
  startFirstMessage,
  startInstructions,
  startOriginId,
  tasksErrorDetail,
  type ModelConfiguration,
  type ModelReference,
  type SessionLiveness,
  type SessionReference,
  type StartBlocker,
  type StartCommand,
  type StartPreview,
  type StartPreviewCommand,
  type StartedSession,
  type TasksErrorDetail,
  type TasksResult,
  type TasksSessionBridgePort,
} from "@claxedo/tasks"
import type { Workspace } from "../workspace/store/index"

const PREVIEW_TTL_MS = 5 * 60_000

/** One workspace's runtime, already addressed and authorized by its host. */
export type TasksRuntimeTarget = {
  workspace: Workspace
  request(path: string, init?: RequestInit): Promise<Response>
}

export type TasksSessionReservation =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; error: TasksErrorDetail }

/**
 * What differs between the hosts that run Tasks sessions: which runtimes they
 * can reach, where session metadata lives, and whether a create needs a
 * managed reservation first. Everything else about a Start — validation,
 * instructions, the deterministic origin and its first message — is the same
 * work against the same runtime routes, and lives below.
 */
export type TasksSessionHost = {
  /** The workspace's runtime, or null when this host cannot reach one for it. */
  target(workspaceId: string): Promise<TasksRuntimeTarget | null>
  sessionMetas(
    sessionIds: readonly string[],
  ): Promise<ReadonlyMap<string, { workspaceID?: string; archived?: number }>>
  /** Admission this host requires before a session may be created under an origin. */
  reserve?(input: {
    origin: string
    sessionId: string
    workspaceId: string
    title: string
  }): Promise<TasksSessionReservation>
  /** Record the created session where this host's session lists read it from. */
  projectSessionMeta(input: {
    sessionId: string
    target: TasksRuntimeTarget
    title: string
    model: ModelReference
  }): Promise<void>
}

export function createTasksSessionBridge(host: TasksSessionHost): TasksSessionBridgePort {
  return {
    async sessionState(sessions) {
      return sessionStates(host, sessions)
    },

    async preview(command) {
      const resolved = await resolveStart(host, command)
      if (!resolved.ok) return resolved
      return { ok: true, preview: resolved.preview }
    },

    async start(command) {
      const resolved = await resolveStart(host, command)
      if (!resolved.ok) return resolved
      if (!resolved.preview.available) {
        const blocker = resolved.preview.blockers[0]
        return {
          ok: false,
          error: tasksErrorDetail("unsupported", blocker ? blocker.detail : "This configuration cannot be started here"),
        }
      }
      if (command.previewDigest !== resolved.preview.digest) {
        return {
          ok: false,
          error: tasksErrorDetail("conflict", "The previewed configuration is no longer the one this Start would run"),
        }
      }
      return startSession(host, command, resolved)
    },
  }
}

type Handoff = { session: SessionReference; transcript: string }

type ResolvedStart = {
  ok: true
  preview: StartPreview
  target: TasksRuntimeTarget | null
  configuration: ModelConfiguration
  instructions: string
  handoff: Handoff | null
}

type Refusal = { ok: false; error: TasksErrorDetail }

async function sessionStates(
  host: TasksSessionHost,
  sessions: readonly SessionReference[],
): Promise<ReadonlyArray<{ session: SessionReference; state: SessionLiveness }>> {
  if (sessions.length === 0) return []
  const metas = await host.sessionMetas(sessions.map((session) => session.sessionId))
  return Promise.all(sessions.map(async (session) => {
    const meta = metas.get(session.sessionId)
    if (!meta) return { session, state: "deleted" as const }
    if (meta.archived) return { session, state: "archived" as const }
    const target = await host.target(meta.workspaceID ?? session.workspaceId ?? "")
    if (!target) return { session, state: "unavailable" as const }
    const reachable = await target.request(`/session/${encodeURIComponent(session.sessionId)}`).catch(() => undefined)
    if (!reachable) return { session, state: "unavailable" as const }
    if (reachable.status === 404) return { session, state: "deleted" as const }
    return { session, state: reachable.ok ? ("live" as const) : ("unavailable" as const) }
  }))
}

export function tasksHarnessQuery(harness: { id: string; access: "native" | "connection" }): string {
  return `${harness.access === "native" ? "nativeHarness" : "connectionId"}=${encodeURIComponent(harness.id)}`
}

function workspaceNameOrDirectory(workspace: Workspace): string {
  return workspace.workspace_name || workspace.directory
}

/**
 * What the harness registered for this workspace says about the chosen model.
 * A harness that selects its own model would run something other than the
 * preset's choice, which is a refusal rather than a silent substitution.
 */
async function configurationBlocker(
  target: TasksRuntimeTarget,
  configuration: ModelConfiguration,
): Promise<StartBlocker | null> {
  const response = await target
    .request(`/session/capabilities?${tasksHarnessQuery(configuration.harness)}`)
    .catch(() => undefined)
  if (!response?.ok) {
    return {
      code: "harness_unavailable",
      detail: `The ${configuration.harness.id} harness is not available in ${workspaceNameOrDirectory(target.workspace)}`,
    }
  }
  const selection = asRecord(asRecord(await response.json().catch(() => undefined))?.modelSelection)
  if (selection?.status === "unsupported") {
    return {
      code: "model_unavailable",
      detail: `The ${configuration.harness.id} harness selects its own model and would ignore ${configuration.model.modelID}`,
    }
  }
  const models = Array.isArray(selection?.models) ? selection.models : []
  if (models.length === 0) return null
  const offered = models.some((model) =>
    isRecord(model)
    && model.providerId === configuration.model.providerID
    && model.modelId === configuration.model.modelID)
  return offered ? null : {
    code: "model_unavailable",
    detail: `${configuration.model.providerID}/${configuration.model.modelID} is not offered by the ${configuration.harness.id} harness here`,
  }
}

async function readMessages(target: TasksRuntimeTarget, sessionId: string): Promise<AgentMessage[] | null> {
  const response = await target.request(`/session/${encodeURIComponent(sessionId)}/message`).catch(() => undefined)
  if (!response?.ok) return null
  const body: unknown = await response.json().catch(() => undefined)
  return Array.isArray(body) ? body.filter(isAgentMessage) : null
}

async function readHarness(target: TasksRuntimeTarget, sessionId: string): Promise<SessionHarness | null> {
  const response = await target.request(`/session/${encodeURIComponent(sessionId)}/config`).catch(() => undefined)
  if (!response?.ok) return null
  const harness = asRecord(asRecord(await response.json().catch(() => undefined))?.harness)
  const id = typeof harness?.id === "string" ? harness.id : undefined
  const access = harness?.access === "native" || harness?.access === "connection" ? harness.access : undefined
  return id && access ? { id, access } : null
}

/** The previous session's conversation, rendered by the runtime's own renderer. */
async function readHandoff(
  host: TasksSessionHost,
  fallback: TasksRuntimeTarget,
  previous: SessionReference | null,
): Promise<Handoff | null> {
  if (!previous) return null
  const target = previous.workspaceId && previous.workspaceId !== fallback.workspace.id
    ? await host.target(previous.workspaceId)
    : fallback
  if (!target) return null
  const [messages, harness] = await Promise.all([
    readMessages(target, previous.sessionId),
    readHarness(target, previous.sessionId),
  ])
  if (!messages?.length || !harness) return null
  return { session: previous, transcript: renderSessionHandoff(messages, harness) }
}

function previousSessionOf(command: StartPreviewCommand | StartCommand): SessionReference | null {
  if ("previousSession" in command) return command.previousSession
  return command.continueFromPrevious ? (command.currentLink?.sessionRef ?? null) : null
}

async function resolveStart(
  host: TasksSessionHost,
  command: StartPreviewCommand | StartCommand,
): Promise<ResolvedStart | Refusal> {
  const placement = command.preset.execution.placement
  const target = command.task.workspaceId ? await host.target(command.task.workspaceId) : null
  const blockers: StartBlocker[] = []
  if (placement === "cloud") {
    blockers.push({
      code: "placement_unsupported",
      detail: "This host starts sessions in the task's own workspace; an isolated cloud root is not available yet",
    })
  }
  if (!target) {
    blockers.push({
      code: "source_unavailable",
      detail: command.task.workspaceId
        ? `Workspace ${command.task.workspaceId} is not reachable from this host`
        : "This task has no workspace to start a session in",
    })
  }

  const handoff = target && blockers.length === 0 ? await readHandoff(host, target, previousSessionOf(command)) : null
  let composed
  try {
    composed = startInstructions({
      preset: command.preset,
      slot: command.slot,
      handoffTranscript: handoff?.transcript ?? null,
    })
  } catch (error) {
    if (error instanceof TasksError) return { ok: false, error: error.detail }
    throw error
  }
  if (target && blockers.length === 0) {
    const blocker = await configurationBlocker(target, composed.configuration)
    if (blocker) blockers.push(blocker)
  }

  const currentLink = "currentLink" in command ? command.currentLink : null
  const currentState = "currentState" in command ? command.currentState : null
  return {
    ok: true,
    target,
    configuration: composed.configuration,
    instructions: composed.text,
    handoff,
    preview: {
      digest: await startDigest({
        scopeId: command.actor.scopeId,
        taskId: command.task.id,
        taskRevision: command.task.revision,
        presetId: command.preset.id,
        presetRevision: command.preset.revision,
        slot: command.slot,
        attempt: command.attempt,
        placement,
        configuration: composed.configuration,
        instructions: composed.text,
      }),
      expiresAt: Date.now() + PREVIEW_TTL_MS,
      placement,
      slot: command.slot,
      attempt: command.attempt,
      configuration: composed.configuration,
      capabilities: command.preset.execution.capabilities,
      available: blockers.length === 0,
      blockers,
      currentSession: currentLink
        ? { sessionRef: currentLink.sessionRef, liveness: currentState ?? "unavailable" }
        : null,
      previousTranscriptReadable: handoff !== null,
      destinationDescription: destination(target, composed.instructionsBytesDropped, composed.transcriptBytesDropped),
    },
  }
}

function destination(
  target: TasksRuntimeTarget | null,
  instructionsDropped: number,
  transcriptDropped: number,
): string {
  const where = target
    ? `${workspaceNameOrDirectory(target.workspace)}, with that workspace's own skills and plugins`
    : "No reachable workspace"
  const dropped = [
    ...(instructionsDropped > 0 ? [`${instructionsDropped} bytes of preset instructions`] : []),
    ...(transcriptDropped > 0 ? [`${transcriptDropped} bytes of the previous session`] : []),
  ]
  return dropped.length === 0 ? where : `${where}. The instruction block cap dropped ${dropped.join(" and ")}.`
}

async function startSession(
  host: TasksSessionHost,
  command: StartCommand,
  resolved: ResolvedStart,
): Promise<TasksResult<{ session: StartedSession }>> {
  const target = resolved.target
  if (!target) return { ok: false, error: tasksErrorDetail("unsupported", "This task has no reachable workspace") }
  const origin = startOriginId(command.actor.scopeId, command.task.id, command.slot, command.attempt)
  // The origin decides both ids, so two clients racing one slot and attempt
  // converge on one session and one first message instead of two of each.
  const hash = (await hashRequest(origin)).slice(0, 32)
  const sessionId = `ses_tasks_${hash}`
  const messageId = `msg_tasks_${hash}`

  const reserved = await host.reserve?.({ origin, sessionId, workspaceId: target.workspace.id, title: command.task.title })
  if (reserved && !reserved.ok) return reserved

  const existing = await target.request(`/session/${encodeURIComponent(sessionId)}`).catch(() => undefined)
  if (!existing) return { ok: false, error: tasksErrorDetail("unsupported", "The workspace runtime is unreachable") }
  if (existing.status !== 200) {
    const created = await target.request(`/session?${tasksHarnessQuery(resolved.configuration.harness)}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...reserved?.headers },
      body: JSON.stringify({
        id: sessionId,
        title: command.task.title,
        model: resolved.configuration.model,
        ...(resolved.configuration.effort ? { variant: resolved.configuration.effort } : {}),
        instructions: resolved.instructions,
      }),
    })
    if (!created.ok) return { ok: false, error: await runtimeRefusal("create this session", created) }
    await host.projectSessionMeta({
      sessionId,
      target,
      title: command.task.title,
      model: resolved.configuration.model,
    })
  }

  if (!(await alreadySent(target, sessionId, messageId))) {
    const prompt = await target.request(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messageID: messageId,
        parts: [{ type: "text", text: startFirstMessage({ task: command.task, handoffText: command.handoffText }) }],
      }),
    })
    if (!prompt.ok) return { ok: false, error: await runtimeRefusal("send the first message", prompt) }
  }

  return {
    ok: true,
    session: {
      sessionRef: { sessionId, workspaceId: target.workspace.id },
      continuedFrom: resolved.handoff?.session ?? null,
    },
  }
}

/**
 * Whether this origin's first message is already on the session. The runtime
 * does not deduplicate by `messageID`, so a retry that skipped this read would
 * send the task a second time.
 */
async function alreadySent(target: TasksRuntimeTarget, sessionId: string, messageId: string): Promise<boolean> {
  const messages = await readMessages(target, sessionId)
  return !!messages?.some((message) => message.info.id === messageId)
}

async function runtimeRefusal(operation: string, response: Response): Promise<TasksErrorDetail> {
  const error = asRecord(asRecord(await response.json().catch(() => undefined))?.error)
  const detail = typeof error?.message === "string" ? error.message : `status ${response.status}`
  return tasksErrorDetail("unsupported", `The workspace runtime refused to ${operation}: ${detail}`)
}
