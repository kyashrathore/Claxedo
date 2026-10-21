import { cloudRootRefusal, allocateCloudRoot, abandonOriginSession, createOriginSession, handOffToSession, readHandoffTranscript, sessionStates, startTarget, type CloudRoot, type SessionHandoffTranscript, type SessionHost, type SessionRuntimeTarget } from "@claxedo/server-core/plugin-platform/sessions/session-bridge-core"
import { configurationBlockers, workspaceNameOrDirectory } from "@claxedo/server-core/plugin-platform/sessions/configuration-blockers"
import type { SessionOrigin as PlatformSessionOrigin } from "@claxedo/server-core/plugin-platform/sessions/origin-ids"
import { unstartable } from "@claxedo/server-core/plugin-platform/sessions/session-start"
import {
  STARTED_SESSION_RUNTIME,
  TasksError,
  attachmentDataUrl,
  cloudPresetHarnessRefusal,
  startDigest,
  startFirstMessage,
  startInstructions,
  startModelGroup,
  startOriginId,
  type ConfigurationSlot,
  type ModelConfiguration,
  type PresetExecution,
  type SessionOrigin,
  type SessionRef,
  type StartBlocker,
  type StartCommand,
  type StartPreview,
  type StartModelGroup,
  type StartPreviewCommand,
  type StartedSessionRuntime,
  type TasksActor,
  type TasksErrorDetail,
  type TasksSessionBridgePort,
} from "../index"

const PREVIEW_TTL_MS = 5 * 60_000

/** The platform namespace Tasks' session and message ids are minted under. */
const TASKS_SESSION_NAMESPACE = "tasks"

export type TasksSessionHost = SessionHost<TasksActor>

/** One root per `(scope, task, slot, attempt)`: the key is the kit's own origin string, so the root, the session and the reservation share it. */
function tasksSessionOrigin(input: { scopeId: string; taskId: string; slot: ConfigurationSlot; attempt: number }): PlatformSessionOrigin {
  return { namespace: TASKS_SESSION_NAMESPACE, key: startOriginId(input.scopeId, input.taskId, input.slot, input.attempt) }
}

function taskOrigin(origin: SessionOrigin): PlatformSessionOrigin {
  return tasksSessionOrigin({ scopeId: origin.scopeId, taskId: origin.taskId, slot: origin.slot, attempt: origin.attempt })
}

/**
 * A Start's runtime target travels back to this host as the handle the package
 * carries, opaquely, from the Start's answer into the handoff or abandonment
 * the same service call runs; one minted by another host's bridge is not a
 * target this one can send through.
 */
type HandledTarget = SessionRuntimeTarget & StartedSessionRuntime

const runtimeHandle = (target: SessionRuntimeTarget): HandledTarget => ({ ...target, [STARTED_SESSION_RUNTIME]: true })

const isHandledTarget = (handle: StartedSessionRuntime): handle is HandledTarget =>
  "workspace" in handle && typeof handle.workspace === "object" && handle.workspace !== null && "request" in handle && typeof handle.request === "function"

const handledTarget = (handle: StartedSessionRuntime | undefined): SessionRuntimeTarget | undefined =>
  handle && isHandledTarget(handle) ? handle : undefined

type CloudCapabilities = Extract<PresetExecution, { placement: "cloud" }>["capabilities"]

function cloudRoot(command: StartPreviewCommand | StartCommand, capabilities: CloudCapabilities): CloudRoot<TasksActor> {
  return {
    actor: command.actor,
    origin: tasksSessionOrigin({ scopeId: command.actor.scopeId, taskId: command.task.id, slot: command.slot, attempt: command.attempt }),
    projectId: command.task.projectId,
    orgId: command.actor.scopeId,
    displayName: `${command.task.title} (${command.slot}, attempt ${command.attempt})`,
    capabilities,
  }
}

/** Tasks' half of Start over a host's session ports: the preset's instruction block, the task's first message and the slot's origin. */
export function createTasksSessionBridge(host: TasksSessionHost): TasksSessionBridgePort {
  return {
    sessionState: (origins) => sessionStates(host, origins.map((origin) => ({ origin: taskOrigin(origin), session: origin.sessionRef }))),

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
        return { ok: false, error: { code: "conflict", message: "The previewed configuration is no longer the one this Start would run" } }
      }
      let target = resolved.target
      if (!target) {
        const execution = command.preset.execution
        if (execution.placement !== "cloud") return unstartable([])
        const allocated = await allocateCloudRoot(host, cloudRoot(command, execution.capabilities), resolved.configuration)
        if (!("target" in allocated)) return allocated
        target = allocated.target
      }
      const created = await createOriginSession(host, {
        actor: command.actor,
        origin: tasksSessionOrigin({ scopeId: command.actor.scopeId, taskId: command.task.id, slot: command.slot, attempt: command.attempt }),
        target,
        title: command.task.title,
        configuration: resolved.configuration,
        group: resolved.group,
        instructions: resolved.instructions,
        configurationDigest: command.configurationDigest,
      })
      if (!created.ok) return created
      return {
        ok: true,
        session: { sessionRef: created.session, continuedFrom: resolved.handoff?.session ?? null, startedFrom: null, startedBy: "person" },
        runtime: runtimeHandle(target),
      }
    },

    // Images travel as the file parts the composer sends them as, after the
    // text, so the agent reads the task before it looks at what it illustrates.
    async handoff(command) {
      const runtime = handledTarget(command.runtime)
      return handOffToSession(host, {
        actor: command.actor,
        origin: tasksSessionOrigin({ scopeId: command.actor.scopeId, taskId: command.task.id, slot: command.slot, attempt: command.attempt }),
        session: command.session,
        parts: [
          { type: "text", text: startFirstMessage({ task: command.task, handoffText: command.handoffText }) },
          ...command.attachments.map((attachment) => ({ type: "file" as const, mime: attachment.mime, filename: attachment.filename, url: attachmentDataUrl(attachment) })),
        ],
        ...(runtime ? { runtime } : {}),
      })
    },

    async abandon(command) {
      const runtime = handledTarget(command.runtime)
      return abandonOriginSession(host, {
        actor: command.actor,
        origin: tasksSessionOrigin({ scopeId: command.actor.scopeId, taskId: command.task.id, slot: command.slot, attempt: command.attempt }),
        session: command.sessionRef,
        configurationDigest: command.configurationDigest,
        reason: "The Tasks link this session was created for was never committed",
        ...(runtime ? { runtime } : {}),
      })
    },
  }
}

/** `target` is the local workspace a Start runs in; a cloud root has none until the Start allocates it. */
type ResolvedStart = {
  ok: true
  preview: StartPreview
  target: SessionRuntimeTarget | null
  configuration: ModelConfiguration
  group: StartModelGroup
  instructions: string
  handoff: SessionHandoffTranscript | null
}

type Refusal = { ok: false; error: TasksErrorDetail }

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

async function cloudBlocker(host: TasksSessionHost, command: StartPreviewCommand | StartCommand, capabilities: CloudCapabilities): Promise<StartBlocker | undefined> {
  if (!host.cloudTarget) {
    return { code: "placement_unsupported", detail: "This host starts sessions in the task's own workspace; an isolated cloud root is not available yet" }
  }
  const harness = command.preset.configurations[command.slot]?.harness
  const elsewhere = harness && cloudPresetHarnessRefusal(harness)
  if (elsewhere) return { code: "harness_unavailable", detail: elsewhere }
  return cloudRootRefusal(host, cloudRoot(command, capabilities))
}

async function resolveStart(host: TasksSessionHost, command: StartPreviewCommand | StartCommand): Promise<ResolvedStart | Refusal> {
  const execution = command.preset.execution
  const placement = execution.placement
  const blockers: StartBlocker[] = []
  let target: SessionRuntimeTarget | null = null
  if (execution.placement === "cloud") {
    const refused = await cloudBlocker(host, command, execution.capabilities)
    if (refused) blockers.push(refused)
  } else {
    const choice = await startTarget(host, { workspaceId: command.task.workspaceId ?? null, projectId: command.task.projectId, starter: command.actor })
    if ("target" in choice) target = choice.target
    else blockers.push({ code: "source_unavailable", detail: choice.detail })
  }

  let readable: SessionHandoffTranscript | null = null
  if (blockers.length === 0) {
    const read = await readHandoffTranscript(host, { fallback: target, previous: previousSessionOf(command), authorize: command.authorizeTranscript, reader: command.actor })
    if (!read.ok) return read
    readable = read.handoff
  }
  // Reading the transcript answers whether Continue can be offered; rendering
  // it into the instruction block is what selecting Continue does.
  const handoff = command.continueFromPrevious ? readable : null
  let composed
  try {
    composed = startInstructions({ preset: command.preset, slot: command.slot, handoffTranscript: handoff?.transcript ?? null })
  } catch (error) {
    if (error instanceof TasksError) return { ok: false, error: error.detail }
    throw error
  }
  if (target && blockers.length === 0) blockers.push(...await configurationBlockers(target, composed.configuration))

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
      currentSession: currentLink ? { sessionRef: currentLink.sessionRef, liveness: currentState ?? "unavailable" } : null,
      previousTranscriptReadable: readable !== null,
      destinationDescription: destination(placement, target, composed.instructionsBytesDropped, composed.transcriptBytesDropped),
    },
  }
}

function destination(placement: StartPreview["placement"], target: SessionRuntimeTarget | null, instructionsDropped: number, transcriptDropped: number): string {
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
