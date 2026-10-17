import { sessionVariantForEffort } from "@claxedo/agent-runtime-contract"
import { renderSessionHandoff } from "@claxedo/agent-runtime-contract"
import { sessionCreateRequest } from "@claxedo/server-core/workspace/http/session-create-request"
import {
  STARTED_SESSION_RUNTIME,
  TasksError,
  attachmentDataUrl,
  cloudPresetHarnessRefusal,
  startDigest,
  startFirstMessage,
  startInstructions,
  startModelGroup,
  tasksErrorDetail,
  type ConfigurationSlot,
  type ModelConfiguration,
  type ModelReference,
  type PresetExecution,
  type SessionAbandonCommand,
  type SessionHandoffCommand,
  type SessionHandoffState,
  type SessionLiveness,
  type SessionOrigin,
  type SessionRef,
  type StartBlocker,
  type StartCommand,
  type StartPreview,
  type StartModelGroup,
  type StartPreviewCommand,
  type StartedSession,
  type StartedSessionRuntime,
  type TranscriptGrant,
  type Task,
  type TasksActor,
  type TasksErrorDetail,
  type TasksResult,
  type TasksSessionBridgePort,
} from "@claxedo/tasks"
import type { Workspace } from "../workspace/store/index"
import { configurationBlockers, workspaceNameOrDirectory } from "./configuration-blockers"
import { originIds } from "./origin-ids"
import { registeredSessionStates, type RegisteredSession } from "./registered-sessions"
import {
  alreadySent,
  readMessages,
  readSessionConfiguration,
  runtimeRefusal,
  sessionTimes,
  untimedSession,
  type SessionConfiguration,
  type SessionTimes,
} from "./session-runtime-answers"

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

/**
 * Where a cloud-placement root runs, the workspace whose start is still under
 * way, or the blocker that says why it does not run. The refusal names its own
 * blocker because the two answers are not the same refusal: a deployment with
 * no sandbox driver cannot offer this placement at all, while one that has a
 * driver and could not reach the project's source has an unavailable source.
 */
export type TasksCloudTargetChoice =
  | { target: TasksRuntimeTarget }
  | { preparing: { workspaceId: string } }
  | { blocker: StartBlocker }

/** The root a cloud allocation is bound to: one workspace per `(scope, task, slot, attempt)`. */
export type TasksCloudOrigin = {
  actor: TasksActor
  task: Task
  slot: ConfigurationSlot
  attempt: number
  /**
   * The capability set this root runs, from the preset being started. The host
   * projects it onto the allocated workspace; it is carried here rather than
   * re-read from the preset later because a preset edited mid-Start must not
   * change what the reserved configuration already resolved.
   */
  capabilities: Extract<PresetExecution, { placement: "cloud" }>["capabilities"]
}

export type TasksSessionReservation =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; error: TasksErrorDetail }

/** What differs between the hosts that run Tasks sessions. */
export type TasksSessionHost = {
  /**
   * The workspace's runtime, or null when this host cannot reach one for it,
   * reached as `actor`: the person a Start acts for, whose accounts a session
   * it creates spends, or who reads a previous transcript or removes an
   * unlinked session. A liveness reading acts for nobody.
   */
  target(workspaceId: string, actor: TasksActor | null): Promise<TasksRuntimeTarget | null>
  /**
   * Where a task with no workspace preference runs. A task names a project;
   * naming a workspace inside it is optional, and most tasks created from the
   * UI never do, so the host resolves the project's own workspace instead of
   * the Start refusing for a choice nobody was asked to make.
   */
  projectTarget(projectId: string, starter: TasksActor): Promise<TasksTargetChoice>
  /**
   * The isolated workspace a cloud-placement preset runs in, allocated to this
   * root and recovered by a retry of it. It answers as soon as the root's start
   * is under way rather than once its sandbox runs; the same Start sent once it
   * runs finds the target. A host that names none cannot offer cloud placement,
   * and a preset asking for one is blocked rather than started in the task's
   * own workspace.
   */
  cloudTarget?(origin: TasksCloudOrigin): Promise<TasksCloudTargetChoice>
  /**
   * Why this host would refuse to allocate the root, read without filing a row
   * or starting anything, because a preview has no side effects.
   */
  cloudRefusal?(origin: TasksCloudOrigin): Promise<StartBlocker | undefined>
  sessionMetas(
    sessionIds: readonly string[],
  ): Promise<ReadonlyMap<string, { workspaceID?: string; archived?: number }>>
  /**
   * The rows these sessions' runtimes publish to this host's registry, for a
   * host whose runtimes publish every session they hold: liveness is read
   * from them and never from a runtime. Absent, each session's runtime is
   * asked.
   */
  registeredSessions?(sessionIds: readonly string[]): Promise<ReadonlyMap<string, RegisteredSession>>
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
  /**
   * Undo of `reserve`, for a session this host created under an origin the
   * package then never linked. A host with no reservation table has neither.
   */
  release?(input: {
    actor: TasksActor
    operationId: string
    sessionId: string
    workspaceId: string
    reason: string
  }): Promise<void>
  /**
   * Record the created session where this host's session lists read it from.
   * Absent on a host whose runtime registers every session it creates with
   * the authority `sessionMetas` reads: that registration is the record.
   */
  projectSessionMeta?(input: {
    sessionId: string
    target: TasksRuntimeTarget
    title: string
    model: ModelReference
    time: SessionTimes
  }): Promise<void>
  /** Remove what `projectSessionMeta` wrote, so an abandoned session leaves no row behind. */
  forgetSessionMeta?(sessionId: string): Promise<void>
}

/**
 * A Start's runtime target travels back to this host as the handle the package
 * carries, opaquely, from the Start's answer into the handoff or abandonment
 * the same service call runs; one minted by another host's bridge is not a
 * target this one can send through.
 */
type HandledTarget = TasksRuntimeTarget & StartedSessionRuntime

const runtimeHandle = (target: TasksRuntimeTarget): HandledTarget => ({ ...target, [STARTED_SESSION_RUNTIME]: true })

const isHandledTarget = (handle: StartedSessionRuntime): handle is HandledTarget =>
  "workspace" in handle && typeof handle.workspace === "object" && handle.workspace !== null && "request" in handle && typeof handle.request === "function"

const handledTarget = (handle: StartedSessionRuntime | undefined): TasksRuntimeTarget | undefined =>
  handle && isHandledTarget(handle) ? handle : undefined

export function createTasksSessionBridge(host: TasksSessionHost): TasksSessionBridgePort {
  return {
    async sessionState(origins) {
      if (!host.registeredSessions) return sessionStates(host, origins)
      return registeredSessionStates(origins, await host.registeredSessions(origins.map((origin) => origin.sessionRef.sessionId)))
    },

    async preview(command) {
      const resolved = await resolveStart(host, command)
      if (!resolved.ok) return resolved
      return { ok: true, preview: resolved.preview }
    },

    async start(command) {
      const resolved = await resolveStart(host, command)
      if (!resolved.ok) return resolved
      if (!resolved.preview.available) return unstartable(resolved.preview.blockers)
      if (command.previewDigest !== resolved.preview.digest) {
        return {
          ok: false,
          error: tasksErrorDetail("conflict", "The previewed configuration is no longer the one this Start would run"),
        }
      }
      if (resolved.target) return startSession(host, command, resolved, resolved.target)
      const allocated = await allocateCloudRoot(host, command, resolved)
      return "target" in allocated ? startSession(host, command, resolved, allocated.target) : allocated
    },

    async handoff(command) {
      return sendFirstMessage(host, command)
    },

    async abandon(command) {
      return abandonSession(host, command)
    },
  }
}

type Handoff = { session: SessionRef; transcript: string }

/** `target` is the local workspace a Start runs in; a cloud root has none until the Start allocates it. */
type ResolvedStart = {
  ok: true
  preview: StartPreview
  target: TasksRuntimeTarget | null
  configuration: ModelConfiguration
  group: StartModelGroup
  instructions: string
  handoff: Handoff | null
}

type Refusal = { ok: false; error: TasksErrorDetail }

/**
 * Liveness, and for a live session whether this origin's first message reached
 * it. A session nobody can read answers `unknown` rather than `pending`: the
 * two differ by whether anything may be sent on the strength of the answer.
 */
async function sessionStates(
  host: TasksSessionHost,
  origins: readonly SessionOrigin[],
): Promise<ReadonlyArray<{ session: SessionRef; state: SessionLiveness; handoff: SessionHandoffState }>> {
  if (origins.length === 0) return []
  const metas = await host.sessionMetas(origins.map((origin) => origin.sessionRef.sessionId))
  return Promise.all(origins.map(async (origin) => {
    const session = origin.sessionRef
    const unread = (state: SessionLiveness) => ({ session, state, handoff: "unknown" as const })
    const meta = metas.get(session.sessionId)
    if (!meta) return unread("deleted")
    if (meta.archived) return unread("archived")
    const target = await host.target(meta.workspaceID ?? session.workspaceId, null)
    if (!target) return unread("unavailable")
    const reachable = await target.request(`/session/${encodeURIComponent(session.sessionId)}`).catch(() => undefined)
    if (!reachable) return unread("unavailable")
    if (reachable.status === 404) return unread("deleted")
    if (!reachable.ok) return unread("unavailable")
    const { messageId } = await originIds(origin)
    const sent = await alreadySent(target, session.sessionId, messageId)
    return {
      session,
      state: "live" as const,
      handoff: sent === "unreadable" ? ("unknown" as const) : sent === "present" ? ("sent" as const) : ("pending" as const),
    }
  }))
}

/**
 * The previous session's conversation, rendered by the runtime's own renderer.
 *
 * The grant is answered here rather than by the caller because resolving the
 * session's workspace is itself an await: a grant the package held when it
 * handed this session over can be gone by the time there is a runtime to read,
 * and the read must not happen on the strength of the older answer.
 */
async function readHandoff(
  host: TasksSessionHost,
  fallback: TasksRuntimeTarget | null,
  previous: SessionRef | null,
  authorize: TranscriptGrant,
  reader: TasksActor,
): Promise<{ ok: true; handoff: Handoff | null } | Refusal> {
  if (!previous) return { ok: true, handoff: null }
  const target = previous.workspaceId === fallback?.workspace.id
    ? fallback
    : await host.target(previous.workspaceId, reader)
  if (!target) return { ok: true, handoff: null }
  if (!(await authorize())) {
    return {
      ok: false,
      error: tasksErrorDetail("forbidden", `No access to session ${previous.sessionId}, so its transcript was not read`),
    }
  }
  const [messages, stored] = await Promise.all([
    readMessages(target, previous.sessionId),
    readSessionConfiguration(target, previous.sessionId),
  ])
  if (!messages?.length || !stored) return { ok: true, handoff: null }
  return { ok: true, handoff: { session: previous, transcript: renderSessionHandoff(messages, stored.harness) } }
}

/**
 * The session a Continue would carry over. A preview names the slot's current
 * session whatever the checkbox says, because the checkbox is what the answer
 * is for: a dialog can only offer Continue once this host has read that
 * transcript, and the kit has already authorized the link it came on.
 *
 * A session the kit reports deleted is the exception. Nothing can be continued
 * from it, and the kit asks its session authority about that link only when
 * there is something to open — so reading its transcript here would be reading
 * one nobody authorized.
 */
function previousSessionOf(command: StartPreviewCommand | StartCommand): SessionRef | null {
  if ("previousSession" in command) return command.previousSession
  if (command.currentState === "deleted") return null
  return command.currentLink?.sessionRef ?? null
}

type CloudCapabilities = Extract<PresetExecution, { placement: "cloud" }>["capabilities"]

function cloudOrigin(command: StartPreviewCommand | StartCommand, capabilities: CloudCapabilities): TasksCloudOrigin {
  return { actor: command.actor, task: command.task, slot: command.slot, attempt: command.attempt, capabilities }
}

async function cloudRefusal(
  host: TasksSessionHost,
  command: StartPreviewCommand | StartCommand,
  capabilities: CloudCapabilities,
): Promise<StartBlocker | undefined> {
  if (!host.cloudTarget) {
    return {
      code: "placement_unsupported",
      detail: "This host starts sessions in the task's own workspace; an isolated cloud root is not available yet",
    }
  }
  const harness = command.preset.configurations[command.slot]?.harness
  const elsewhere = harness && cloudPresetHarnessRefusal(harness)
  if (elsewhere) return { code: "harness_unavailable", detail: elsewhere }
  return host.cloudRefusal?.(cloudOrigin(command, capabilities))
}

/**
 * The cloud root this Start runs in, allocated now. A root whose start is
 * still under way answers `preparing`; the harness is asked about the model
 * only once the root runs, because only a running runtime can answer.
 */
async function allocateCloudRoot(
  host: TasksSessionHost,
  command: StartCommand,
  resolved: ResolvedStart,
): Promise<{ target: TasksRuntimeTarget } | Refusal | { ok: true; preparing: { workspaceId: string } }> {
  const execution = command.preset.execution
  if (execution.placement !== "cloud" || !host.cloudTarget) return unstartable([])
  const choice = await host.cloudTarget(cloudOrigin(command, execution.capabilities))
  if ("blocker" in choice) return unstartable([choice.blocker])
  if ("preparing" in choice) return { ok: true, preparing: choice.preparing }
  const blockers = await configurationBlockers(choice.target, resolved.configuration)
  return blockers.length === 0 ? { target: choice.target } : unstartable(blockers)
}

function unstartable(blockers: readonly StartBlocker[]): Refusal {
  const blocker = blockers[0]
  return {
    ok: false,
    error: tasksErrorDetail(
      blocker?.code === "rate_limited" ? "rate_limited" : "unsupported",
      blocker ? blocker.detail : "This configuration cannot be started here",
    ),
  }
}

async function startTarget(host: TasksSessionHost, task: Task, starter: TasksActor): Promise<TasksTargetChoice> {
  if (!task.workspaceId) return host.projectTarget(task.projectId, starter)
  const target = await host.target(task.workspaceId, starter)
  return target ? { target } : { detail: `Workspace ${task.workspaceId} is not reachable from this host` }
}

async function resolveStart(
  host: TasksSessionHost,
  command: StartPreviewCommand | StartCommand,
): Promise<ResolvedStart | Refusal> {
  const execution = command.preset.execution
  const placement = execution.placement
  const blockers: StartBlocker[] = []
  let target: TasksRuntimeTarget | null = null
  if (execution.placement === "cloud") {
    const refused = await cloudRefusal(host, command, execution.capabilities)
    if (refused) blockers.push(refused)
  } else {
    const choice = await startTarget(host, command.task, command.actor)
    if ("target" in choice) target = choice.target
    else blockers.push({ code: "source_unavailable", detail: choice.detail })
  }

  let readable: Handoff | null = null
  if (blockers.length === 0) {
    const read = await readHandoff(host, target, previousSessionOf(command), command.authorizeTranscript, command.actor)
    if (!read.ok) return read
    readable = read.handoff
  }
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
    blockers.push(...await configurationBlockers(target, composed.configuration))
  }

  const currentLink = "currentLink" in command ? command.currentLink : null
  const currentState = "currentState" in command ? command.currentState : null
  return {
    ok: true,
    target,
    configuration: composed.configuration,
    group: startModelGroup(command.preset),
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
      destinationDescription: destination(placement, target, composed.instructionsBytesDropped, composed.transcriptBytesDropped),
    },
  }
}

function destination(
  placement: StartPreview["placement"],
  target: TasksRuntimeTarget | null,
  instructionsDropped: number,
  transcriptDropped: number,
): string {
  const where = placement === "cloud"
    ? "A cloud workspace of its own, with the preset's skills and plugins"
    : target
      ? `${workspaceNameOrDirectory(target.workspace)}, with that workspace's own skills and plugins`
      : "No reachable workspace"
  const dropped = [
    ...(instructionsDropped > 0 ? [`${instructionsDropped} bytes of preset instructions`] : []),
    ...(transcriptDropped > 0 ? [`${transcriptDropped} bytes of the previous session`] : []),
  ]
  return dropped.length === 0 ? where : `${where}. The instruction block cap dropped ${dropped.join(" and ")}.`
}

const creating = new Map<string, Promise<unknown>>()

/**
 * One creator per origin inside this process.
 *
 * The session id is derived from the origin, so two concurrent Starts would
 * otherwise both read it as absent and create it — the second with whichever
 * configuration its own preset resolved, under the id the first one is already
 * using. A host with a managed reservation refuses the second before it gets
 * here; an unsigned local host has no such table, and one process is the whole
 * of it.
 */
async function perOrigin<T>(origin: string, work: () => Promise<T>): Promise<T> {
  const queued = (creating.get(origin) ?? Promise.resolve()).then(work, work)
  const tail = queued.then(
    () => undefined,
    () => undefined,
  )
  creating.set(origin, tail)
  void tail.then(() => {
    if (creating.get(origin) === tail) creating.delete(origin)
  })
  return queued
}

async function startSession(
  host: TasksSessionHost,
  command: StartCommand,
  resolved: ResolvedStart,
  target: TasksRuntimeTarget,
): Promise<TasksResult<{ session: StartedSession; runtime: StartedSessionRuntime }>> {
  const { origin, sessionId } = await originIds({
    scopeId: command.actor.scopeId,
    taskId: command.task.id,
    slot: command.slot,
    attempt: command.attempt,
  })
  // The reservation carries the configuration the ids do not: a host that
  // admits one operation per origin then refuses a second configuration
  // claiming the same session instead of letting it adopt the first one.
  const operationId = `${origin}:${command.configurationDigest}`

  const held = await perOrigin(origin, async (): Promise<{ ok: true } | Refusal> => {
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
    if (existing.status === 200) return recoverSession(host, target, existing, sessionId, command, resolved)

    const create = sessionCreateRequest({
      id: sessionId,
      title: command.task.title,
      model: resolved.configuration.model,
      harness: resolved.configuration.harness,
      group: resolved.group,
      instructions: resolved.instructions,
      ...sessionVariantForEffort(resolved.configuration.effort ?? undefined),
    })
    const created = await target.request(create.path, {
      method: "POST",
      headers: { "content-type": "application/json", ...reserved?.headers },
      body: create.body,
    })
    if (!created.ok) {
      // A runtime that refuses because the id is taken has the session another
      // Start created, which is the same situation as finding it above: adopt
      // it only if it is running this configuration.
      const collided = await target.request(`/session/${encodeURIComponent(sessionId)}`).catch(() => undefined)
      if (collided?.status === 200) return recoverSession(host, target, collided, sessionId, command, resolved)
      return { ok: false, error: await runtimeRefusal("create this session", created) }
    }
    const time = await sessionTimes(created)
    if (!time) return untimedSession(sessionId)
    await host.projectSessionMeta?.({
      sessionId,
      target,
      title: command.task.title,
      model: resolved.configuration.model,
      time,
    })
    return { ok: true }
  })
  if (!held.ok) return held

  return {
    ok: true,
    session: {
      sessionRef: { sessionId, workspaceId: target.workspace.id },
      continuedFrom: resolved.handoff?.session ?? null,
      startedFrom: null,
      startedBy: "person",
    },
    runtime: runtimeHandle(target),
  }
}

/**
 * The task, handed to the session the committed link names. The message id
 * comes from the origin and the history is read first, so a Start retried
 * after a crash between the link and this call sends the task once, and one
 * retried after it landed sends nothing.
 */
async function sendFirstMessage(
  host: TasksSessionHost,
  command: SessionHandoffCommand,
): Promise<TasksResult<{ sent: boolean }>> {
  const target = handledTarget(command.runtime) ?? await host.target(command.session.workspaceId, command.actor)
  if (!target) {
    return {
      ok: false,
      error: tasksErrorDetail("unsupported", `Session ${command.session.sessionId} is not reachable from this host`),
    }
  }
  const { messageId } = await originIds({
    scopeId: command.actor.scopeId,
    taskId: command.task.id,
    slot: command.slot,
    attempt: command.attempt,
  })
  const sent = await alreadySent(target, command.session.sessionId, messageId)
  if (sent === "unreadable") {
    return {
      ok: false,
      error: tasksErrorDetail(
        "conflict",
        "The workspace runtime would not say whether this task was already handed to the session; it was not sent again",
      ),
    }
  }
  if (sent === "present") return { ok: true, sent: false }
  // Images travel as the file parts the composer sends them as, after the
  // text, so the agent reads the task before it looks at what it illustrates.
  const prompt = await target.request(`/session/${encodeURIComponent(command.session.sessionId)}/prompt_async`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messageID: messageId,
      parts: [
        { type: "text", text: startFirstMessage({ task: command.task, handoffText: command.handoffText }) },
        ...command.attachments.map((attachment) => ({
          type: "file",
          mime: attachment.mime,
          filename: attachment.filename,
          url: attachmentDataUrl(attachment),
        })),
      ],
    }),
  })
  if (!prompt.ok) return { ok: false, error: await runtimeRefusal("send the first message", prompt) }
  return { ok: true, sent: true }
}

/**
 * A session this origin created and nobody linked, removed so the next Start
 * may have the origin back.
 *
 * The history is read first for the same reason the handoff reads it: this
 * origin's first message on the session means the task was handed over and the
 * session is the user's, whatever the caller believes about the link. The
 * reservation is released after the delete, so a host whose delete failed
 * still holds the origin rather than freeing an id its session still answers.
 */
async function abandonSession(
  host: TasksSessionHost,
  command: SessionAbandonCommand,
): Promise<TasksResult<{ removed: boolean }>> {
  const target = handledTarget(command.runtime) ?? await host.target(command.sessionRef.workspaceId, command.actor)
  if (!target) {
    return {
      ok: false,
      error: tasksErrorDetail("unsupported", `Session ${command.sessionRef.sessionId} is not reachable from this host`),
    }
  }
  const sessionId = command.sessionRef.sessionId
  const { origin, messageId } = await originIds({
    scopeId: command.actor.scopeId,
    taskId: command.task.id,
    slot: command.slot,
    attempt: command.attempt,
  })
  const sent = await alreadySent(target, sessionId, messageId)
  if (sent === "present") return { ok: true, removed: false }
  if (sent === "unreadable") {
    return {
      ok: false,
      error: tasksErrorDetail(
        "conflict",
        `The workspace runtime would not say whether session ${sessionId} had already been handed the task; it was kept`,
      ),
    }
  }
  const removed = await target.request(`/session/${encodeURIComponent(sessionId)}`, { method: "DELETE" })
  if (!removed.ok) return { ok: false, error: await runtimeRefusal("delete this session", removed) }
  await host.forgetSessionMeta?.(sessionId)
  await host.release?.({
    actor: command.actor,
    operationId: `${origin}:${command.configurationDigest}`,
    sessionId,
    workspaceId: target.workspace.id,
    reason: "The Tasks link this session was created for was never committed",
  })
  return { ok: true, removed: true }
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
  session: Response,
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
    if (!host.projectSessionMeta) {
      return {
        ok: false,
        error: tasksErrorDetail(
          "conflict",
          `Session ${sessionId} exists but its registration with this control plane is unresolved, so this Start did not adopt it`,
        ),
      }
    }
    const time = await sessionTimes(session)
    if (!time) return untimedSession(sessionId)
    await host.projectSessionMeta({
      sessionId,
      target,
      title: command.task.title,
      model: resolved.configuration.model,
      time,
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
