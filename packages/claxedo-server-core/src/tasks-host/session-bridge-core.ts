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
  type Task,
  type TasksActor,
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

/**
 * The workspace a Start will run in, or why this host has none for it. A
 * refusal carries its own sentence because only the host knows what it looked
 * at — which workspaces a project has, and which of them it can reach.
 */
export type TasksTargetChoice = { target: TasksRuntimeTarget } | { detail: string }

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
  /**
   * Where a task with no workspace preference runs. A task names a project;
   * naming a workspace inside it is optional, and most tasks created from the
   * UI never do, so the host resolves the project's own workspace instead of
   * the Start refusing for a choice nobody was asked to make.
   */
  projectTarget(projectId: string): Promise<TasksTargetChoice>
  sessionMetas(
    sessionIds: readonly string[],
  ): Promise<ReadonlyMap<string, { workspaceID?: string; archived?: number }>>
  /**
   * Admission this host requires before a session may be created under an
   * origin. `operationId` is the origin and the configuration digest, so a
   * second configuration reaching the same session id collides here instead of
   * adopting the session the first one created. The actor comes with it because
   * a hosted reservation records the creator, and a session created for anyone
   * but the person who started it is one they cannot open.
   */
  reserve?(input: {
    actor: TasksActor
    operationId: string
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

/**
 * What the runtime says a session runs, or null when it does not answer. The
 * model is optional because a session may leave the harness's own selection in
 * place, and the harness alone is what rendering its transcript needs.
 */
type SessionConfiguration = {
  harness: SessionHarness
  model: ModelReference | null
  effort: string | null
  instructions: string
}

async function readSessionConfiguration(
  target: TasksRuntimeTarget,
  sessionId: string,
): Promise<SessionConfiguration | null> {
  const response = await target.request(`/session/${encodeURIComponent(sessionId)}/config`).catch(() => undefined)
  if (!response?.ok) return null
  const body = asRecord(await response.json().catch(() => undefined))
  const harness = asRecord(body?.harness)
  const id = typeof harness?.id === "string" ? harness.id : undefined
  const access = harness?.access === "native" || harness?.access === "connection" ? harness.access : undefined
  if (!id || !access) return null
  const model = asRecord(body?.model)
  const providerID = typeof model?.providerID === "string" ? model.providerID : undefined
  const modelID = typeof model?.modelID === "string" ? model.modelID : undefined
  return {
    harness: { id, access },
    model: providerID && modelID ? { providerID, modelID } : null,
    effort: typeof body?.variant === "string" ? body.variant : null,
    instructions: typeof body?.instructions === "string" ? body.instructions : "",
  }
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
  const [messages, stored] = await Promise.all([
    readMessages(target, previous.sessionId),
    readSessionConfiguration(target, previous.sessionId),
  ])
  if (!messages?.length || !stored) return null
  return { session: previous, transcript: renderSessionHandoff(messages, stored.harness) }
}

/**
 * The session a Continue would carry over. A preview names the slot's current
 * session whatever the checkbox says, because the checkbox is what the answer
 * is for: a dialog can only offer Continue once this host has read that
 * transcript, and the kit has already authorized the link it came on.
 */
function previousSessionOf(command: StartPreviewCommand | StartCommand): SessionReference | null {
  if ("previousSession" in command) return command.previousSession
  return command.currentLink?.sessionRef ?? null
}

async function startTarget(host: TasksSessionHost, task: Task): Promise<TasksTargetChoice> {
  if (!task.workspaceId) return host.projectTarget(task.projectId)
  const target = await host.target(task.workspaceId)
  return target ? { target } : { detail: `Workspace ${task.workspaceId} is not reachable from this host` }
}

/**
 * Which of a project's workspaces a task without a preference starts in.
 *
 * The project's own root workspace is the answer wherever there is one. Past
 * that the rows are worktrees and clones of one repository, and picking the
 * oldest or the first would silently run the task somewhere the user did not
 * choose — so an unresolved choice is handed back to them by name.
 */
export function chooseProjectWorkspace(
  projectId: string,
  workspaces: readonly Workspace[],
): { workspace: Workspace } | { detail: string } {
  const candidates = workspaces.filter((workspace) => (workspace.project_id ?? workspace.id) === projectId)
  const only = candidates.length === 1 ? candidates.at(0) : undefined
  if (only) return { workspace: only }
  if (candidates.length === 0) {
    return { detail: `Project ${projectId} has no workspace this host can start a session in` }
  }
  const root = candidates.find((workspace) => workspace.id === projectId)
  if (root) return { workspace: root }
  const checkouts = candidates.filter((workspace) => !workspace.repo_root || workspace.repo_root === workspace.directory)
  const checkout = checkouts.length === 1 ? checkouts.at(0) : undefined
  if (checkout) return { workspace: checkout }
  const names = candidates.map((workspace) => workspace.workspace_name || workspace.directory).join(", ")
  return {
    detail: `Project ${projectId} has ${candidates.length} workspaces (${names}); name one on the task before starting`,
  }
}

async function resolveStart(
  host: TasksSessionHost,
  command: StartPreviewCommand | StartCommand,
): Promise<ResolvedStart | Refusal> {
  const placement = command.preset.execution.placement
  const choice = await startTarget(host, command.task)
  const blockers: StartBlocker[] = []
  if (placement === "cloud") {
    blockers.push({
      code: "placement_unsupported",
      detail: "This host starts sessions in the task's own workspace; an isolated cloud root is not available yet",
    })
  }
  if (!("target" in choice)) blockers.push({ code: "source_unavailable", detail: choice.detail })
  const target = "target" in choice ? choice.target : null

  const readable = target && blockers.length === 0 ? await readHandoff(host, target, previousSessionOf(command)) : null
  // Reading the transcript answers whether Continue can be offered; rendering
  // it into the instruction block is what selecting Continue does.
  const handoff = command.continueFromPrevious ? readable : null
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
      previousTranscriptReadable: readable !== null,
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
  // The reservation carries the configuration the ids do not: a host that
  // admits one operation per origin then refuses a second configuration
  // claiming the same session instead of letting it adopt the first one.
  const operationId = `${origin}:${command.configurationDigest}`

  const reserved = await host.reserve?.({
    actor: command.actor,
    operationId,
    sessionId,
    workspaceId: target.workspace.id,
    title: command.task.title,
  })
  if (reserved && !reserved.ok) return reserved

  const existing = await target.request(`/session/${encodeURIComponent(sessionId)}`).catch(() => undefined)
  if (!existing) return { ok: false, error: tasksErrorDetail("unsupported", "The workspace runtime is unreachable") }
  if (existing.status === 200) {
    const recovered = await recoverSession(host, target, sessionId, command, resolved)
    if (!recovered.ok) return recovered
  } else {
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

  const sent = await alreadySent(target, sessionId, messageId)
  if (sent === "unreadable") {
    return {
      ok: false,
      error: tasksErrorDetail(
        "conflict",
        "The workspace runtime would not say whether this task was already handed to the session; it was not sent again",
      ),
    }
  }
  if (sent === "absent") {
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
 * A session this origin already created, taken back over. Two things have to
 * hold before it may answer this Start: it must be running the configuration
 * this Start resolved, and the session lists this host reads liveness from
 * must know about it.
 */
async function recoverSession(
  host: TasksSessionHost,
  target: TasksRuntimeTarget,
  sessionId: string,
  command: StartCommand,
  resolved: ResolvedStart,
): Promise<{ ok: true } | Refusal> {
  const stored = await readSessionConfiguration(target, sessionId)
  if (!stored) {
    return {
      ok: false,
      error: tasksErrorDetail(
        "conflict",
        `The workspace runtime would not say what session ${sessionId} is configured to run, so this Start did not adopt it`,
      ),
    }
  }
  if (!sameConfiguration(stored, resolved)) {
    return {
      ok: false,
      error: tasksErrorDetail(
        "conflict",
        `Session ${sessionId} is already running another configuration for this attempt; start the next attempt instead`,
      ),
    }
  }
  // Metadata is written by the create this Start skipped. Left missing, the
  // session lists read the attempt as deleted and admit another one while
  // this session is still running.
  const metas = await host.sessionMetas([sessionId])
  if (!metas.has(sessionId)) {
    await host.projectSessionMeta({
      sessionId,
      target,
      title: command.task.title,
      model: resolved.configuration.model,
    })
  }
  return { ok: true }
}

function sameConfiguration(stored: SessionConfiguration, resolved: ResolvedStart): boolean {
  return stored.harness.id === resolved.configuration.harness.id
    && stored.harness.access === resolved.configuration.harness.access
    && stored.model?.providerID === resolved.configuration.model.providerID
    && stored.model?.modelID === resolved.configuration.model.modelID
    && stored.effort === (resolved.configuration.effort ?? null)
    && stored.instructions === resolved.instructions
}

/**
 * Whether this origin's first message is already on the session. The runtime
 * does not deduplicate by `messageID`, so a retry that skipped this read would
 * send the task a second time — and a history it would not return is not the
 * same answer as a history without the message.
 */
async function alreadySent(
  target: TasksRuntimeTarget,
  sessionId: string,
  messageId: string,
): Promise<"present" | "absent" | "unreadable"> {
  const messages = await readMessages(target, sessionId)
  if (!messages) return "unreadable"
  return messages.some((message) => message.info.id === messageId) ? "present" : "absent"
}

async function runtimeRefusal(operation: string, response: Response): Promise<TasksErrorDetail> {
  const error = asRecord(asRecord(await response.json().catch(() => undefined))?.error)
  const detail = typeof error?.message === "string" ? error.message : `status ${response.status}`
  return tasksErrorDetail("unsupported", `The workspace runtime refused to ${operation}: ${detail}`)
}
