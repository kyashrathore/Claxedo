import {
  linkView,
  type ChildListQuery,
  type ConfigurationSlot,
  type Page,
  type Preset,
  type SessionHandoffState,
  type SessionLiveness,
  type SessionReference,
  type StartPreview,
  type StartPreviewRequest,
  type StartRequest,
  type StartResponse,
  type Task,
  type TaskArchiveInput,
  type TaskCommandResult,
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
import { sessionOriginOf, type TasksSessionBridgePort } from "../ports/session-bridge"
import { TasksStoreConflict, type TasksStorePort } from "../ports/store"
import { admissibleAttempt, startConfigurationDigest } from "../start"
import { validateReparent, validateTaskDraft, validateTaskEdit } from "./model"

export type TasksServiceDeps = {
  store: TasksStorePort
  clock: TasksClockPort
  ids: TasksIdsPort
  authorization: TasksAuthorizationPort
  bridge: TasksSessionBridgePort
}

type SlotReading = { state: SessionLiveness; handoff: SessionHandoffState }

type CurrentSlot = { link: TaskSessionLink | null; state: SessionLiveness | null; handoff: SessionHandoffState }

export type TasksService = {
  list(actor: TasksActor, query: TaskListQuery): Promise<Page<TaskSummary>>
  children(actor: TasksActor, taskId: string, query: ChildListQuery): Promise<Page<TaskSummary>>
  detail(actor: TasksActor, taskId: string): Promise<TaskDetailResponse>
  /** The task, or a refusal, for a caller that must prove write access before acting on it. */
  requireWritable(actor: TasksActor, taskId: string): Promise<Task>
  create(actor: TasksActor, input: TaskCreateInput): Promise<TaskCommandResult>
  edit(actor: TasksActor, input: TaskEditInput): Promise<TaskCommandResult>
  setStatus(actor: TasksActor, input: TaskSetStatusInput): Promise<TaskCommandResult>
  reparent(actor: TasksActor, input: TaskReparentInput): Promise<TaskCommandResult>
  archive(actor: TasksActor, input: TaskArchiveInput): Promise<TaskCommandResult>
  restore(actor: TasksActor, input: TaskRestoreInput): Promise<TaskCommandResult>
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

  const UNREAD: SlotReading = { state: "unavailable", handoff: "unknown" }

  const readingsOf = async (links: readonly TaskSessionLink[]): Promise<Map<string, SlotReading>> => {
    if (links.length === 0) return new Map()
    const readings = await deps.bridge.sessionState(links.map(sessionOriginOf))
    return new Map(readings.map((reading) => [reading.session.sessionId, { state: reading.state, handoff: reading.handoff }]))
  }

  /**
   * The task's links, as far as this actor may see them. The owner's liveness
   * reading decides which need a grant to open: a deleted session cannot be
   * opened by anyone, and hiding it would cost the reader the attempt number
   * the next Start has to name. Every other state is a session this actor must
   * be allowed to open before the link is named at all.
   */
  const linkViews = async (actor: TasksActor, links: readonly TaskSessionLink[]): Promise<readonly TaskSessionLinkView[]> => {
    const readings = await readingsOf(links)
    const visible: TaskSessionLinkView[] = []
    for (const link of links) {
      const reading = readings.get(link.sessionRef.sessionId) ?? UNREAD
      if (reading.state !== "deleted" && !(await deps.authorization.authorizeSessionOpen(actor, link.sessionRef))) continue
      visible.push(linkView(link, reading.state, reading.handoff))
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
  const currentSlotState = async (actor: TasksActor, taskId: string, slot: ConfigurationSlot): Promise<CurrentSlot> => {
    const link = await deps.store.links.getCurrent(actor.scopeId, taskId, slot)
    if (!link) return { link: null, state: null, handoff: "unknown" }
    const reading = (await readingsOf([link])).get(link.sessionRef.sessionId) ?? UNREAD
    if (reading.state !== "deleted") await requireSessionOpen(actor, link)
    return { link, state: reading.state, handoff: reading.handoff }
  }

  /**
   * The slot's current link is its highest attempt. Attempt `current` is the
   * idempotent re-request while the owner reports that session live; attempt
   * `current + 1` is only admissible once the owner reports it gone. Anything
   * else is two clients disagreeing about which session a slot holds.
   */
  const checkAttempt = (attempt: number, current: CurrentSlot): void => {
    if (!current.link) {
      if (attempt !== 1) refuse("conflict", `Slot has no session yet; the first attempt is 1, not ${attempt}`)
      return
    }
    const admissible = admissibleAttempt({ attempt: current.link.attempt, liveness: current.state ?? "unavailable" })
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
  ): Promise<{ task: Task; preset: Preset; current: CurrentSlot; configurationDigest: string }> => {
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
   * The first message, after the link that names its session is durable. The
   * text comes from the link rather than the request, so the message a crash
   * interrupted is the one that eventually arrives; the host decides its id
   * from the origin, so a session that already has it is left alone.
   */
  const handOff = async (actor: TasksActor, task: Task, link: TaskSessionLink): Promise<void> => {
    const handed = await deps.bridge.handoff({
      actor,
      task,
      slot: link.slot,
      attempt: link.attempt,
      handoffText: link.handoffText,
      session: link.sessionRef,
    })
    if (!handed.ok) throw new TasksError(handed.error)
  }

  /**
   * A session a Start created and this settlement refused to link, handed back
   * to the host so the origin is free for the next one.
   *
   * The stored link is read first: a settlement refused because another client
   * had already claimed the origin with this same session must leave that
   * client's session alone, and only a session no link names is this Start's
   * to give back. A host that refuses to give it back keeps it, and the
   * settlement's own refusal is still what the caller is answered with.
   */
  const abandonUnlinked = async (
    actor: TasksActor,
    task: Task,
    request: StartRequest,
    configurationDigest: string,
    sessionRef: SessionReference,
  ): Promise<void> => {
    const held = await deps.store.links.getCurrent(actor.scopeId, task.id, request.slot)
    if (held?.sessionRef.sessionId === sessionRef.sessionId) return
    await deps.bridge.abandon({
      actor,
      task,
      slot: request.slot,
      attempt: request.attempt,
      configurationDigest,
      sessionRef,
    })
  }

  /**
   * Whether this actor may still read the slot's previous transcript, asked at
   * the moment the host reads it rather than when the slot was read here.
   */
  const transcriptGrant = (actor: TasksActor, session: SessionReference | null) => async (): Promise<boolean> =>
    session !== null && (await deps.authorization.authorizeSessionOpen(actor, session))

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
        number: await deps.store.tasks.nextNumber(actor.scopeId, draft.projectId),
        workspaceId: parent ? parent.workspaceId : draft.workspaceId,
        parentTaskId: draft.parentTaskId,
        createdFrom: draft.createdFrom ?? null,
        title: draft.title,
        description: draft.description,
        status: draft.status ?? "todo",
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
        authorizeTranscript: transcriptGrant(actor, current.state === "deleted" ? null : current.link?.sessionRef ?? null),
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
        // This is also the recovery the UI calls for a link whose first message
        // never landed, so the handoff runs unless the host's readback has
        // already seen it. An unreadable history is refused inside the handoff
        // rather than guessed at here.
        if (current.handoff !== "sent") await handOff(actor, task, current.link)
        return { link: linkView(current.link, "live", "sent"), created: false }
      }

      // A session the owner reports deleted carries nothing over and was never
      // authorized here, so it is not offered as one to continue from. The
      // grant is taken again for the rest, and once more inside the bridge,
      // because the read it admits happens after the host has resolved a
      // runtime to read from.
      const continued = request.continueFromPrevious && current.link && current.state !== "deleted" ? current.link : null
      if (continued) await requireSessionOpen(actor, continued)

      const started = await deps.bridge.start({
        authorizeTranscript: transcriptGrant(actor, continued?.sessionRef ?? null),
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
        handoffText: request.handoffText,
        startedFrom: started.session.startedFrom,
        placement: preset.execution.placement,
        createdAt: deps.clock.now(),
      }

      // The session exists by now, so the link commits under live authority and
      // against the revisions that authorized this Start. A task revision names
      // an immutable row, so a task archived, moved or re-attempted meanwhile
      // fails here, and the write carries that revision rather than a re-read,
      // because a store that decides nothing until commit decides it there.
      // Advancing the revision is also what makes an edit that read the task
      // before the link existed fail its own compare-and-set. The preset is
      // asserted for the same reason the task is pinned: its instructions and
      // configuration went into the session, and a preset edited while the
      // session was being created would leave the link naming a revision that
      // never ran. Asserting rather than re-reading is what makes that a
      // predicate of the commit on a store that decides nothing before it.
      const settled = await deps.store.transaction(async (tx): Promise<{ link: TaskSessionLink; created: boolean }> => {
        await authorize(actor, task.projectId, "write")
        if (!(await tx.presets.assertRevision(actor.scopeId, preset.id, preset.revision))) {
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
      }).catch(async (cause: unknown) => {
        // The session was created and nothing names it, so it is given back
        // before the refusal travels: left behind it holds the origin, and the
        // attempt the user would retry is neither startable nor replaceable.
        await abandonUnlinked(actor, task, request, configurationDigest, started.session.sessionRef)
        // A store that only discovers a broken predicate at commit reports it
        // here; for this unit either kind means the same thing, and Start has
        // no receipt to replay it from.
        if (cause instanceof TasksStoreConflict) refuse("conflict", cause.message)
        throw cause
      })

      await handOff(actor, task, settled.link)

      // A handoff that resolved is the origin's message on the session, whether
      // this call submitted it or found it already there.
      const reading = (await readingsOf([settled.link])).get(settled.link.sessionRef.sessionId) ?? UNREAD
      return { link: linkView(settled.link, reading.state, "sent"), created: settled.created }
    },
  }
}
