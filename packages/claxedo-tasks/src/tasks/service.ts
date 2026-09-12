import {
  linkView,
  type ChildListQuery,
  type ConfigurationSlot,
  type Page,
  type Preset,
  type SessionLiveness,
  type SessionReference,
  type StartPreview,
  type StartPreviewRequest,
  type StartRequest,
  type StartResponse,
  type Task,
  type TaskArchiveInput,
  type TaskCreateInput,
  type TaskDetailResponse,
  type TaskEditInput,
  type TaskListQuery,
  type TaskReparentInput,
  type TaskRestoreInput,
  type TaskSessionLink,
  type TaskSessionLinkView,
  type TaskSetStatusInput,
  type TaskSummary,
  type TasksActor,
} from "../contracts"
import { TasksError, refuse, refuseInvalid } from "../errors"
import type { TasksAuthorizationPort } from "../ports/authorization"
import type { TasksClockPort } from "../ports/clock"
import type { TasksIdsPort } from "../ports/ids"
import type { TasksSessionBridgePort } from "../ports/session-bridge"
import { TasksStoreConflict, type TasksStorePort } from "../ports/store"
import { startConfigurationDigest } from "../start"
import { validateReparent, validateTaskDraft, validateTaskEdit } from "./model"

export type TasksServiceDeps = {
  store: TasksStorePort
  clock: TasksClockPort
  ids: TasksIdsPort
  authorization: TasksAuthorizationPort
  bridge: TasksSessionBridgePort
}

export type TaskMutation = { task: Task; parent: Task | null }

export type TasksService = {
  list(actor: TasksActor, query: TaskListQuery): Promise<Page<TaskSummary>>
  children(actor: TasksActor, taskId: string, query: ChildListQuery): Promise<Page<TaskSummary>>
  detail(actor: TasksActor, taskId: string): Promise<TaskDetailResponse>
  /** The task, or a refusal, for a caller that must prove write access before acting on it. */
  requireWritable(actor: TasksActor, taskId: string): Promise<Task>
  create(actor: TasksActor, input: TaskCreateInput): Promise<TaskMutation>
  edit(actor: TasksActor, input: TaskEditInput): Promise<TaskMutation>
  setStatus(actor: TasksActor, input: TaskSetStatusInput): Promise<TaskMutation>
  reparent(actor: TasksActor, input: TaskReparentInput): Promise<TaskMutation>
  archive(actor: TasksActor, input: TaskArchiveInput): Promise<TaskMutation>
  restore(actor: TasksActor, input: TaskRestoreInput): Promise<TaskMutation>
  startPreview(actor: TasksActor, taskId: string, request: StartPreviewRequest): Promise<StartPreview>
  start(actor: TasksActor, taskId: string, request: StartRequest): Promise<StartResponse>
}

export function createTasksService(deps: TasksServiceDeps): TasksService {
  const authorize = async (actor: TasksActor, projectId: string, access: "read" | "write"): Promise<void> => {
    if (!(await deps.authorization.authorizeProject(actor, projectId, access))) {
      refuse("forbidden", `No ${access} access to project ${projectId}`)
    }
  }

  const load = async (actor: TasksActor, taskId: string, access: "read" | "write"): Promise<Task> => {
    const task = await deps.store.tasks.get(actor.scopeId, taskId)
    if (!task || task.scopeId !== actor.scopeId) refuse("not_found", `Task ${taskId} was not found`)
    await authorize(actor, task.projectId, access)
    return task
  }

  const atRevision = (task: Task, revision: number): Task => {
    if (task.revision !== revision) {
      refuse("stale_revision", `Task ${task.id} is at revision ${task.revision}`, { currentTask: task })
    }
    return task
  }

  const open = (task: Task): Task => {
    if (task.archivedAt !== null) refuse("conflict", `Task ${task.id} is archived`)
    return task
  }

  const write = async (next: Task, expectedRevision: number): Promise<Task> => {
    if (!(await deps.store.tasks.update(next, expectedRevision))) {
      refuse("stale_revision", `Task ${next.id} changed while it was being saved`)
    }
    return next
  }

  /**
   * A child mutation moves the parent too: its Done guard reads the child set,
   * so the parent's revision has to move for a concurrent parent edit to lose.
   *
   * The snapshot is the caller's, never a fresh read. The guard that admitted
   * the mutation ran against one parent revision, and a store whose reads are
   * not one snapshot can answer a second read with a parent that has since
   * gone Done; committing against that newer revision would discard the
   * evidence the guard was built on.
   */
  const touchParent = async (parent: Task | null): Promise<Task | null> => {
    if (!parent) return null
    const next: Task = {
      ...parent,
      revision: parent.revision + 1,
      childSetRevision: parent.childSetRevision + 1,
      updatedAt: deps.clock.now(),
    }
    return write(next, parent.revision)
  }

  /** The parent of a mutation no parent guard applies to, for its child-set bump alone. */
  const parentSnapshot = async (parentTaskId: string | null, scopeId: string): Promise<Task | null> =>
    parentTaskId === null ? null : ((await deps.store.tasks.get(scopeId, parentTaskId)) ?? null)

  const requireOpenParent = async (actor: TasksActor, parentTaskId: string, projectId: string): Promise<Task> => {
    const parent = await deps.store.tasks.get(actor.scopeId, parentTaskId)
    if (!parent) refuseInvalid("The parent task was not found", [{ path: "parentTaskId", reason: "unknown_value" }])
    if (parent.projectId !== projectId) {
      refuseInvalid("A child must stay in its parent's project", [{ path: "parentTaskId", reason: "not_allowed" }])
    }
    if (parent.parentTaskId !== null) {
      refuseInvalid("Tasks support one level of children", [{ path: "parentTaskId", reason: "not_allowed" }])
    }
    if (parent.archivedAt !== null) refuse("conflict", `Parent task ${parent.id} is archived`)
    if (parent.status === "done") refuse("conflict", `Parent task ${parent.id} is done`)
    return parent
  }

  const hasChildren = async (scopeId: string, taskId: string): Promise<boolean> =>
    (await deps.store.tasks.countChildren(scopeId, taskId, { includeArchived: true, excludeStatus: null })) > 0

  const livenessOf = async (sessions: readonly SessionReference[]): Promise<Map<string, SessionLiveness>> => {
    if (sessions.length === 0) return new Map()
    const readings = await deps.bridge.sessionState(sessions)
    return new Map(readings.map((reading) => [reading.session.sessionId, reading.state]))
  }

  /**
   * The task's links, as far as this actor may see them. The owner's liveness
   * reading decides which need a grant to open: a deleted session cannot be
   * opened by anyone, and hiding it would cost the reader the attempt number
   * the next Start has to name. Every other state is a session this actor must
   * be allowed to open before the link is named at all.
   */
  const linkViews = async (actor: TasksActor, links: readonly TaskSessionLink[]): Promise<readonly TaskSessionLinkView[]> => {
    const states = await livenessOf(links.map((link) => link.sessionRef))
    const visible: TaskSessionLinkView[] = []
    for (const link of links) {
      const state = states.get(link.sessionRef.sessionId) ?? "unavailable"
      if (state !== "deleted" && !(await deps.authorization.authorizeSessionOpen(actor, link.sessionRef))) continue
      visible.push(linkView(link, state))
    }
    return visible
  }

  const requireSessionOpen = async (actor: TasksActor, link: TaskSessionLink): Promise<void> => {
    if (!(await deps.authorization.authorizeSessionOpen(actor, link.sessionRef))) {
      refuse("forbidden", `No access to the session slot ${link.slot} holds`)
    }
  }

  /**
   * The slot's session and how the owner reports it.
   *
   * Liveness is read before authority because it is what says whether there is
   * anything to authorize: a session the owner no longer has discloses nothing
   * and is only evidence that the next attempt may start, so a user whose
   * session authority refuses deleted rows can still Start again. In every
   * other state the session can be opened or copied — it answers an idempotent
   * Start, a readability probe reads its transcript, Continue carries it — so
   * an actor the authority refuses is refused the slot rather than served from
   * it.
   */
  const currentSlotState = async (
    actor: TasksActor,
    taskId: string,
    slot: ConfigurationSlot,
  ): Promise<{ link: TaskSessionLink | null; state: SessionLiveness | null }> => {
    const link = await deps.store.links.getCurrent(actor.scopeId, taskId, slot)
    if (!link) return { link: null, state: null }
    const states = await livenessOf([link.sessionRef])
    const state = states.get(link.sessionRef.sessionId) ?? "unavailable"
    if (state !== "deleted") await requireSessionOpen(actor, link)
    return { link, state }
  }

  /**
   * The slot's current link is its highest attempt. Attempt `current` is the
   * idempotent re-request while the owner reports that session live; attempt
   * `current + 1` is only admissible once the owner reports it gone. Anything
   * else is two clients disagreeing about which session a slot holds.
   */
  const checkAttempt = (attempt: number, current: { link: TaskSessionLink | null; state: SessionLiveness | null }): void => {
    if (!current.link) {
      if (attempt !== 1) refuse("conflict", `Slot has no session yet; the first attempt is 1, not ${attempt}`)
      return
    }
    const admissible = current.state === "live" ? current.link.attempt : current.link.attempt + 1
    if (attempt !== admissible) {
      refuse(
        "conflict",
        `Slot is at attempt ${current.link.attempt} and its session is ${current.state ?? "unknown"}; attempt ${admissible} is the only one accepted`,
      )
    }
  }

  const startSubject = async (
    actor: TasksActor,
    taskId: string,
    request: { taskRevision: number; presetId: string; presetRevision: number; slot: ConfigurationSlot; attempt: number },
  ): Promise<{
    task: Task
    preset: Preset
    current: { link: TaskSessionLink | null; state: SessionLiveness | null }
    configurationDigest: string
  }> => {
    const task = open(atRevision(await load(actor, taskId, "write"), request.taskRevision))
    const preset = await deps.store.presets.get(actor.scopeId, request.presetId)
    if (!preset || preset.ownerId !== actor.ownerId) refuse("not_found", `Preset ${request.presetId} was not found`)
    if (preset.revision !== request.presetRevision) {
      refuse("stale_revision", `Preset ${preset.id} is at revision ${preset.revision}`, { currentPreset: preset })
    }
    if (preset.archivedAt !== null) refuse("conflict", `Preset ${preset.id} is archived`)
    if (!preset.configurations[request.slot]) {
      refuseInvalid(`Preset ${preset.id} has no ${request.slot} configuration`, [{ path: "slot", reason: "unknown_value" }])
    }
    const current = await currentSlotState(actor, taskId, request.slot)
    checkAttempt(request.attempt, current)
    return { task, preset, current, configurationDigest: await startConfigurationDigest({ preset, slot: request.slot }) }
  }

  /**
   * The first message, after the link that names its session is durable. It is
   * repeated on every Start of that attempt because a committed link is no
   * evidence the message was submitted; the host decides the message id from
   * the origin, so a session that already has it is left alone.
   */
  const handOff = async (
    actor: TasksActor,
    task: Task,
    request: StartRequest,
    session: SessionReference,
  ): Promise<void> => {
    const handed = await deps.bridge.handoff({
      actor,
      task,
      slot: request.slot,
      attempt: request.attempt,
      handoffText: request.handoffText,
      session,
    })
    if (!handed.ok) throw new TasksError(handed.error)
  }

  return {
    async list(actor, query) {
      await authorize(actor, query.projectId, "read")
      return deps.store.tasks.list(actor.scopeId, query)
    },

    async children(actor, taskId, query) {
      const task = await load(actor, taskId, "read")
      return deps.store.tasks.listChildren(actor.scopeId, task.id, query)
    },

    async detail(actor, taskId) {
      const task = await load(actor, taskId, "read")
      const links = await deps.store.links.listByTask(actor.scopeId, task.id)
      return { task, links: await linkViews(actor, links) }
    },

    async requireWritable(actor, taskId) {
      return load(actor, taskId, "write")
    },

    async create(actor, input) {
      const checked = validateTaskDraft(input)
      if (!checked.ok) refuseInvalid("The task is not valid", checked.fields)
      const draft = checked.value
      await authorize(actor, draft.projectId, "write")
      const parent = draft.parentTaskId === null ? null : await requireOpenParent(actor, draft.parentTaskId, draft.projectId)
      if (parent && draft.workspaceId !== null && draft.workspaceId !== parent.workspaceId) {
        refuseInvalid("A child keeps its parent's workspace preference", [{ path: "workspaceId", reason: "not_allowed" }])
      }
      const now = deps.clock.now()
      const task: Task = {
        id: deps.ids.taskId(),
        revision: 1,
        scopeId: actor.scopeId,
        projectId: draft.projectId,
        workspaceId: parent ? parent.workspaceId : draft.workspaceId,
        parentTaskId: draft.parentTaskId,
        title: draft.title,
        description: draft.description,
        status: "todo",
        childSetRevision: 0,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      }
      await deps.store.tasks.insert(task)
      return { task, parent: await touchParent(parent) }
    },

    async edit(actor, input) {
      const checked = validateTaskEdit(input)
      if (!checked.ok) refuseInvalid("The task is not valid", checked.fields)
      const current = open(atRevision(await load(actor, input.taskId, "write"), input.revision))
      if (input.workspaceId !== current.workspaceId) {
        const links = await deps.store.links.listByTask(actor.scopeId, current.id)
        if (links.length > 0) {
          refuseInvalid("A linked task keeps the workspace its sessions were started in", [
            { path: "workspaceId", reason: "not_allowed" },
          ])
        }
      }
      const task = await write(
        {
          ...current,
          revision: current.revision + 1,
          title: input.title,
          description: input.description,
          workspaceId: input.workspaceId,
          updatedAt: deps.clock.now(),
        },
        input.revision,
      )
      return { task, parent: null }
    },

    async setStatus(actor, input) {
      const current = open(atRevision(await load(actor, input.taskId, "write"), input.revision))
      if (input.status === "done") {
        const unfinished = await deps.store.tasks.countChildren(actor.scopeId, current.id, {
          includeArchived: false,
          excludeStatus: "done",
        })
        if (unfinished > 0) refuse("conflict", `Task ${current.id} has ${unfinished} unfinished children`)
      }
      const parent = current.parentTaskId === null
        ? null
        : current.status === "done" && input.status !== "done"
          ? await requireOpenParent(actor, current.parentTaskId, current.projectId)
          : await parentSnapshot(current.parentTaskId, actor.scopeId)
      const task = await write(
        { ...current, revision: current.revision + 1, status: input.status, updatedAt: deps.clock.now() },
        input.revision,
      )
      return { task, parent: await touchParent(parent) }
    },

    async reparent(actor, input) {
      const checked = validateReparent(input)
      if (!checked.ok) refuseInvalid("The task cannot be reparented", checked.fields)
      const current = open(atRevision(await load(actor, input.taskId, "write"), input.revision))
      if (input.projectId !== current.projectId) {
        await authorize(actor, input.projectId, "write")
        if (await hasChildren(actor.scopeId, current.id)) {
          refuseInvalid("Move the children first", [{ path: "projectId", reason: "not_allowed" }])
        }
        const links = await deps.store.links.listByTask(actor.scopeId, current.id)
        if (links.length > 0) {
          refuseInvalid("A linked task stays in the project its sessions were started in", [
            { path: "projectId", reason: "not_allowed" },
          ])
        }
      }
      if (input.parentTaskId !== null && (await hasChildren(actor.scopeId, current.id))) {
        refuseInvalid("A task with children cannot become a child", [{ path: "parentTaskId", reason: "not_allowed" }])
      }
      const nextParent =
        input.parentTaskId === null ? null : await requireOpenParent(actor, input.parentTaskId, input.projectId)
      const formerParent = current.parentTaskId !== null && current.parentTaskId !== input.parentTaskId
        ? await parentSnapshot(current.parentTaskId, actor.scopeId)
        : null
      const task = await write(
        {
          ...current,
          revision: current.revision + 1,
          projectId: input.projectId,
          parentTaskId: input.parentTaskId,
          workspaceId: nextParent ? nextParent.workspaceId : current.workspaceId,
          updatedAt: deps.clock.now(),
        },
        input.revision,
      )
      await touchParent(formerParent)
      return { task, parent: await touchParent(nextParent) }
    },

    async archive(actor, input) {
      const current = open(atRevision(await load(actor, input.taskId, "write"), input.revision))
      const living = await deps.store.tasks.countChildren(actor.scopeId, current.id, {
        includeArchived: false,
        excludeStatus: null,
      })
      if (living > 0) refuse("conflict", `Task ${current.id} has ${living} children that are not archived`)
      const parent = await parentSnapshot(current.parentTaskId, actor.scopeId)
      const now = deps.clock.now()
      const task = await write({ ...current, revision: current.revision + 1, archivedAt: now, updatedAt: now }, input.revision)
      return { task, parent: await touchParent(parent) }
    },

    async restore(actor, input) {
      const current = atRevision(await load(actor, input.taskId, "write"), input.revision)
      if (current.archivedAt === null) refuse("conflict", `Task ${current.id} is not archived`)
      const parent =
        current.parentTaskId === null ? null : await requireOpenParent(actor, current.parentTaskId, current.projectId)
      const task = await write(
        { ...current, revision: current.revision + 1, archivedAt: null, updatedAt: deps.clock.now() },
        input.revision,
      )
      return { task, parent: await touchParent(parent) }
    },

    async startPreview(actor, taskId, request) {
      const { task, preset, current } = await startSubject(actor, taskId, request)
      const previewed = await deps.bridge.preview({
        actor,
        task,
        preset,
        slot: request.slot,
        attempt: request.attempt,
        continueFromPrevious: request.continueFromPrevious,
        currentLink: current.link,
        currentState: current.state,
      })
      if (!previewed.ok) throw new TasksError(previewed.error)
      return previewed.preview
    },

    async start(actor, taskId, request) {
      const { task, preset, current, configurationDigest } = await startSubject(actor, taskId, request)

      // Attempt `current` while the session is live is the idempotent
      // re-request: the slot already holds that session, so nothing is
      // created. A request that resolved to another configuration is not that
      // re-request, and answering it with this session would report the other
      // preset as the one running.
      if (current.link && current.state === "live" && request.attempt === current.link.attempt) {
        if (current.link.configurationDigest !== configurationDigest) {
          refuse(
            "conflict",
            `Slot ${request.slot} attempt ${request.attempt} is running a different configuration; start the next attempt instead`,
          )
        }
        await handOff(actor, task, request, current.link.sessionRef)
        return { link: linkView(current.link, "live"), created: false }
      }

      // Continue has the host read the previous session's transcript, so the
      // authority answers again immediately before the call rather than the
      // slot read above standing in for it: a grant lost since then must not
      // reach the bridge as a transcript to copy. A session the owner reports
      // deleted carries nothing over and was never authorized here.
      const continued = request.continueFromPrevious && current.link && current.state !== "deleted" ? current.link : null
      if (continued) await requireSessionOpen(actor, continued)

      const started = await deps.bridge.start({
        actor,
        task,
        preset,
        slot: request.slot,
        attempt: request.attempt,
        previewDigest: request.previewDigest,
        continueFromPrevious: request.continueFromPrevious,
        clientRequestId: request.clientRequestId,
        configurationDigest,
        previousSession: continued?.sessionRef ?? null,
      })
      if (!started.ok) throw new TasksError(started.error)

      const link: TaskSessionLink = {
        scopeId: actor.scopeId,
        taskId: task.id,
        slot: request.slot,
        attempt: request.attempt,
        sessionRef: started.session.sessionRef,
        continuedFrom: started.session.continuedFrom,
        presetId: preset.id,
        presetRevision: preset.revision,
        presetNameAtStart: preset.name,
        configurationDigest,
        createdAt: deps.clock.now(),
      }

      // The session exists by now, so the link commits under live authority and
      // against the revisions that authorized this Start. A task revision names
      // an immutable row, so a task archived, moved or re-attempted meanwhile
      // fails here, and the write carries that revision rather than a re-read,
      // because a store that decides nothing until commit decides it there.
      // Advancing the revision is also what makes an edit that read the task
      // before the link existed fail its own compare-and-set. The preset is
      // re-read for the same reason the task is pinned: its instructions and
      // configuration went into the session, and a preset edited while the
      // session was being created would leave the link naming a revision that
      // never ran.
      const settled = await deps.store.transaction(async (tx): Promise<{ link: TaskSessionLink; created: boolean }> => {
        await authorize(actor, task.projectId, "write")
        const settling = await tx.presets.get(actor.scopeId, preset.id)
        if (!settling || settling.revision !== preset.revision) {
          refuse("conflict", `Preset ${preset.id} changed while its session was being created`)
        }
        const inserted = await tx.links.insert(link)
        if (inserted.status === "exists") {
          // Another client reached this origin first. Its link answers this
          // request only if it is the same session started for the same
          // configuration in the same workspace; anything else is a different
          // Start, and reporting it as this one would name the wrong preset.
          if (
            inserted.link.sessionRef.sessionId === link.sessionRef.sessionId
            && inserted.link.sessionRef.workspaceId === link.sessionRef.workspaceId
            && inserted.link.configurationDigest === link.configurationDigest
          ) {
            return { link: inserted.link, created: false }
          }
          return refuse("conflict", `Slot ${request.slot} attempt ${request.attempt} already holds another session`)
        }
        if (!(await tx.tasks.update({ ...task, revision: task.revision + 1, updatedAt: deps.clock.now() }, task.revision))) {
          refuse("conflict", `Task ${task.id} changed while its session was being created`)
        }
        return { link, created: true }
      }).catch((cause: unknown) => {
        // A store that only discovers a broken predicate at commit reports it
        // here; for this unit either kind means the same thing, and Start has
        // no receipt to replay it from.
        if (cause instanceof TasksStoreConflict) refuse("conflict", cause.message)
        throw cause
      })

      await handOff(actor, task, request, settled.link.sessionRef)

      const states = await livenessOf([settled.link.sessionRef])
      return {
        link: linkView(settled.link, states.get(settled.link.sessionRef.sessionId) ?? "unavailable"),
        created: settled.created,
      }
    },
  }
}
