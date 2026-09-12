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
import type { TasksStorePort } from "../ports/store"
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
   */
  const touchParent = async (parentTaskId: string | null, scopeId: string): Promise<Task | null> => {
    if (parentTaskId === null) return null
    const parent = await deps.store.tasks.get(scopeId, parentTaskId)
    if (!parent) return null
    const next: Task = {
      ...parent,
      revision: parent.revision + 1,
      childSetRevision: parent.childSetRevision + 1,
      updatedAt: deps.clock.now(),
    }
    return write(next, parent.revision)
  }

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

  const authorizedLinks = async (actor: TasksActor, links: readonly TaskSessionLink[]): Promise<readonly TaskSessionLink[]> => {
    const visible: TaskSessionLink[] = []
    for (const link of links) {
      if (await deps.authorization.authorizeSessionOpen(actor, link.sessionRef)) visible.push(link)
    }
    return visible
  }

  const linkViews = async (actor: TasksActor, links: readonly TaskSessionLink[]): Promise<readonly TaskSessionLinkView[]> => {
    const visible = await authorizedLinks(actor, links)
    const states = await livenessOf(visible.map((link) => link.sessionRef))
    return visible.map((link) => linkView(link, states.get(link.sessionRef.sessionId) ?? "unavailable"))
  }

  const currentSlotState = async (
    actor: TasksActor,
    taskId: string,
    slot: ConfigurationSlot,
  ): Promise<{ link: TaskSessionLink | null; state: SessionLiveness | null }> => {
    const link = await deps.store.links.getCurrent(actor.scopeId, taskId, slot)
    if (!link) return { link: null, state: null }
    const states = await livenessOf([link.sessionRef])
    return { link, state: states.get(link.sessionRef.sessionId) ?? "unavailable" }
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
  ): Promise<{ task: Task; preset: Preset; current: { link: TaskSessionLink | null; state: SessionLiveness | null } }> => {
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
    return { task, preset, current }
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
      return { task, parent: await touchParent(task.parentTaskId, actor.scopeId) }
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
      if (current.parentTaskId !== null && current.status === "done" && input.status !== "done") {
        await requireOpenParent(actor, current.parentTaskId, current.projectId)
      }
      const task = await write(
        { ...current, revision: current.revision + 1, status: input.status, updatedAt: deps.clock.now() },
        input.revision,
      )
      return { task, parent: await touchParent(task.parentTaskId, actor.scopeId) }
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
      if (current.parentTaskId !== null && current.parentTaskId !== input.parentTaskId) {
        await touchParent(current.parentTaskId, actor.scopeId)
      }
      return { task, parent: await touchParent(task.parentTaskId, actor.scopeId) }
    },

    async archive(actor, input) {
      const current = open(atRevision(await load(actor, input.taskId, "write"), input.revision))
      const living = await deps.store.tasks.countChildren(actor.scopeId, current.id, {
        includeArchived: false,
        excludeStatus: null,
      })
      if (living > 0) refuse("conflict", `Task ${current.id} has ${living} children that are not archived`)
      const now = deps.clock.now()
      const task = await write({ ...current, revision: current.revision + 1, archivedAt: now, updatedAt: now }, input.revision)
      return { task, parent: await touchParent(task.parentTaskId, actor.scopeId) }
    },

    async restore(actor, input) {
      const current = atRevision(await load(actor, input.taskId, "write"), input.revision)
      if (current.archivedAt === null) refuse("conflict", `Task ${current.id} is not archived`)
      if (current.parentTaskId !== null) await requireOpenParent(actor, current.parentTaskId, current.projectId)
      const task = await write(
        { ...current, revision: current.revision + 1, archivedAt: null, updatedAt: deps.clock.now() },
        input.revision,
      )
      return { task, parent: await touchParent(task.parentTaskId, actor.scopeId) }
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
      const { task, preset, current } = await startSubject(actor, taskId, request)

      // Attempt `current` while the session is live is the idempotent
      // re-request: the slot already holds that session, so nothing is created
      // and no first message is resent.
      if (current.link && current.state === "live" && request.attempt === current.link.attempt) {
        return { link: linkView(current.link, "live"), created: false }
      }

      const continued = request.continueFromPrevious ? (current.link?.sessionRef ?? null) : null
      const started = await deps.bridge.start({
        actor,
        task,
        preset,
        slot: request.slot,
        attempt: request.attempt,
        previewDigest: request.previewDigest,
        handoffText: request.handoffText,
        continueFromPrevious: request.continueFromPrevious,
        clientRequestId: request.clientRequestId,
        previousSession: continued,
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
        createdAt: deps.clock.now(),
      }

      // The session exists by now, so the link is saved against a re-read of
      // the task and a re-checked authority: a task archived, moved or
      // revoked during provisioning must not acquire a session.
      const settled = await deps.store.transaction(async (tx): Promise<{ link: TaskSessionLink; created: boolean }> => {
        const reread = await tx.tasks.get(actor.scopeId, task.id)
        if (!reread || reread.archivedAt !== null || reread.projectId !== task.projectId) {
          refuse("conflict", `Task ${task.id} changed while its session was being created`)
        }
        await authorize(actor, reread.projectId, "write")
        const inserted = await tx.links.insert(link)
        if (inserted.status === "inserted") return { link, created: true }
        if (inserted.link.sessionRef.sessionId === link.sessionRef.sessionId) return { link: inserted.link, created: false }
        return refuse("conflict", `Slot ${request.slot} attempt ${request.attempt} already holds another session`)
      })

      const states = await livenessOf([settled.link.sessionRef])
      return {
        link: linkView(settled.link, states.get(settled.link.sessionRef.sessionId) ?? "unavailable"),
        created: settled.created,
      }
    },
  }
}
