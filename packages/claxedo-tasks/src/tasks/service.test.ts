import { beforeEach, describe, expect, test } from "bun:test"
import { createTasksCommands } from "../commands"
import type { Preset, StartRequest, Task, TaskDraft, TaskSessionLink } from "../contracts"
import { createPresetsService } from "../presets/service"
import { startConfigurationDigest } from "../start"
import { createMemoryTasksStore } from "../stores/memory"
import {
  ACTOR,
  type FakeAuthorization,
  type FakeBridge,
  OTHER_SCOPE,
  fakeAuthorization,
  fakeBridge,
  fakeCapabilities,
  fakeClock,
  fakeIds,
} from "../test-support/fakes"
import { fieldReasons, refusalOf } from "../test-support/refusals"
import { presetDraft, primaryConfiguration, slotted } from "../test-support/rows"
import type { TasksAuthorizationPort } from "../ports/authorization"
import { TasksStoreConflict, type TasksStoreOperations, type TasksStorePort } from "../ports/store"
import { createTasksService, type TasksService } from "./service"

const PROJECT = "project-alpha"

function draft(overrides: Partial<TaskDraft> = {}): TaskDraft {
  return {
    projectId: overrides.projectId ?? PROJECT,
    title: overrides.title ?? "Ship the thing",
    description: overrides.description ?? "",
    workspaceId: overrides.workspaceId ?? null,
    parentTaskId: overrides.parentTaskId ?? null,
    ...(overrides.status === undefined ? {} : { status: overrides.status }),
    ...(overrides.createdFrom === undefined ? {} : { createdFrom: overrides.createdFrom }),
  }
}

describe("tasks service", () => {
  let store: TasksStorePort
  let authorization: FakeAuthorization
  let bridge: FakeBridge
  let tasks: TasksService
  let preset: Preset

  beforeEach(async () => {
    store = createMemoryTasksStore()
    authorization = fakeAuthorization()
    bridge = fakeBridge()
    const clock = fakeClock()
    const ids = fakeIds()
    tasks = createTasksService({ store, clock, ids, authorization, bridge })
    preset = await createPresetsService({ store, clock, ids, capabilities: fakeCapabilities() }).create(
      ACTOR,
      slotted("review"),
    )
  })

  const start = (task: Task, overrides: Partial<StartRequest> = {}): StartRequest => ({
    clientRequestId: overrides.clientRequestId ?? "request-1",
    taskRevision: overrides.taskRevision ?? task.revision,
    presetId: overrides.presetId ?? preset.id,
    presetRevision: overrides.presetRevision ?? preset.revision,
    slot: overrides.slot ?? "primary",
    attempt: overrides.attempt ?? 1,
    previewDigest: overrides.previewDigest ?? "digest-1",
    handoffText: overrides.handoffText ?? null,
    continueFromPrevious: overrides.continueFromPrevious ?? false,
    ...(overrides.startedFrom ? { startedFrom: overrides.startedFrom } : {}),
  })

  describe("creation and the child set", () => {
    test("creates a root task in todo", async () => {
      const { task, parent } = await tasks.create(ACTOR, draft())
      expect(task).toMatchObject({ revision: 1, status: "todo", parentTaskId: null, childSetRevision: 0 })
      expect(parent).toBeNull()
    })

    test("creates into Backlog when the draft asks for it, and moves in and out of it freely", async () => {
      const parked = (await tasks.create(ACTOR, draft({ status: "backlog" }))).task
      expect(parked.status).toBe("backlog")

      const picked = (await tasks.setStatus(ACTOR, { taskId: parked.id, revision: parked.revision, status: "doing" })).task
      expect(picked.status).toBe("doing")
      const shelved = await tasks.setStatus(ACTOR, { taskId: picked.id, revision: picked.revision, status: "backlog" })
      expect(shelved.task.status).toBe("backlog")
    })

    test("numbers each task after the last one in its own project", async () => {
      const first = (await tasks.create(ACTOR, draft())).task
      const second = (await tasks.create(ACTOR, draft())).task
      const child = (await tasks.create(ACTOR, draft({ parentTaskId: first.id }))).task
      const elsewhere = (await tasks.create(ACTOR, draft({ projectId: "project-beta" }))).task

      expect([first.number, second.number, child.number]).toEqual([1, 2, 3])
      expect(elsewhere.number).toBe(1)
    })

    test("a number an archived task holds is not handed to the next one", async () => {
      const first = (await tasks.create(ACTOR, draft())).task
      await tasks.archive(ACTOR, { taskId: first.id, revision: first.revision })

      expect((await tasks.create(ACTOR, draft())).task.number).toBe(2)
    })

    test("records the session a task was created from and reads it back", async () => {
      const origin = { sessionId: "ses_author", workspaceId: "ws_author" }
      const created = (await tasks.create(ACTOR, draft({ createdFrom: origin }))).task
      expect(created.createdFrom).toEqual(origin)
      expect((await tasks.detail(ACTOR, created.id)).task.createdFrom).toEqual(origin)

      const listed = await tasks.list(ACTOR, { projectId: PROJECT, status: null, parent: "any", includeArchived: false, cursor: null, limit: 50 })
      expect(listed.items.find((row) => row.id === created.id)?.createdFrom).toEqual(origin)
    })

    test("a task the app created is created from nobody", async () => {
      expect((await tasks.create(ACTOR, draft())).task.createdFrom).toBeNull()
    })

    test("refuses a creating session that names no session", async () => {
      const refusal = await refusalOf(() => tasks.create(ACTOR, draft({ createdFrom: { sessionId: " ", workspaceId: null } })))
      expect(fieldReasons(refusal)).toEqual({ "createdFrom.sessionId": "required" })
    })

    test("refuses a project the actor cannot write", async () => {
      authorization.denyProject(PROJECT)
      expect((await refusalOf(() => tasks.create(ACTOR, draft()))).code).toBe("forbidden")
    })

    test("a child bumps the parent's revision and child-set revision", async () => {
      const root = (await tasks.create(ACTOR, draft())).task
      const created = await tasks.create(ACTOR, draft({ parentTaskId: root.id }))
      expect(created.task.parentTaskId).toBe(root.id)
      expect(created.parent).toMatchObject({ id: root.id, revision: 2, childSetRevision: 1 })
    })

    test("a child copies its parent's workspace preference and refuses a different one", async () => {
      const root = (await tasks.create(ACTOR, draft({ workspaceId: "workspace-one" }))).task
      const child = await tasks.create(ACTOR, draft({ parentTaskId: root.id }))
      expect(child.task.workspaceId).toBe("workspace-one")

      const detail = await refusalOf(() => tasks.create(ACTOR, draft({ parentTaskId: root.id, workspaceId: "workspace-two" })))
      expect(fieldReasons(detail)).toEqual({ workspaceId: "not_allowed" })
    })

    test("refuses a grandchild, a cross-project child and a done parent", async () => {
      const root = (await tasks.create(ACTOR, draft())).task
      const child = (await tasks.create(ACTOR, draft({ parentTaskId: root.id }))).task

      expect(fieldReasons(await refusalOf(() => tasks.create(ACTOR, draft({ parentTaskId: child.id }))))).toEqual({
        parentTaskId: "not_allowed",
      })
      expect(
        fieldReasons(await refusalOf(() => tasks.create(ACTOR, draft({ parentTaskId: root.id, projectId: "project-beta" })))),
      ).toEqual({ parentTaskId: "not_allowed" })

      const done = (await tasks.setStatus(ACTOR, { taskId: child.id, revision: child.revision, status: "done" })).task
      const closedRoot = (await tasks.detail(ACTOR, root.id)).task
      await tasks.setStatus(ACTOR, { taskId: root.id, revision: closedRoot.revision, status: "done" })
      expect(done.status).toBe("done")
      expect((await refusalOf(() => tasks.create(ACTOR, draft({ parentTaskId: root.id })))).code).toBe("conflict")
    })

    // The parent guard reads one revision; a store whose reads are not one
    // snapshot can hand a later read a parent that has since gone Done, and
    // committing against that revision would carry the guard's evidence away.
    test("a child is refused when its parent goes done after the guard read it", async () => {
      const root = (await tasks.create(ACTOR, draft())).task
      let closed = false
      const closing = (operations: TasksStoreOperations): TasksStoreOperations => ({
        ...operations,
        tasks: {
          ...operations.tasks,
          async get(scopeId, taskId) {
            const found = await operations.tasks.get(scopeId, taskId)
            if (!closed && taskId === root.id && found) {
              closed = true
              await operations.tasks.update({ ...found, revision: found.revision + 1, status: "done" }, found.revision)
            }
            return found
          },
        },
      })
      const racing: TasksStorePort = {
        ...closing(store),
        transaction: (work) => store.transaction((operations) => work(closing(operations))),
      }
      const commands = createTasksCommands({
        store: racing,
        clock: fakeClock(),
        ids: { presetId: () => "preset-child", taskId: () => "task-child" },
        capabilities: fakeCapabilities(),
        authorization,
        bridge,
      })

      const detail = await refusalOf(() =>
        commands.execute(ACTOR, {
          clientRequestId: "child-1",
          command: { type: "task.create", input: draft({ parentTaskId: root.id }) },
        }),
      )
      expect(detail.code).toBe("stale_revision")
      expect((await tasks.children(ACTOR, root.id, { cursor: null, limit: 50, includeArchived: true })).items).toHaveLength(0)
    })
  })

  describe("status", () => {
    test("a parent cannot be done while a child is not", async () => {
      const root = (await tasks.create(ACTOR, draft())).task
      const child = (await tasks.create(ACTOR, draft({ parentTaskId: root.id }))).task
      const current = (await tasks.detail(ACTOR, root.id)).task

      expect((await refusalOf(() => tasks.setStatus(ACTOR, { taskId: root.id, revision: current.revision, status: "done" }))).code).toBe(
        "conflict",
      )

      await tasks.setStatus(ACTOR, { taskId: child.id, revision: child.revision, status: "done" })
      const rebased = (await tasks.detail(ACTOR, root.id)).task
      const closed = await tasks.setStatus(ACTOR, { taskId: root.id, revision: rebased.revision, status: "done" })
      expect(closed.task.status).toBe("done")
    })

    test("an archived child does not hold its parent open", async () => {
      const root = (await tasks.create(ACTOR, draft())).task
      const child = (await tasks.create(ACTOR, draft({ parentTaskId: root.id }))).task
      await tasks.archive(ACTOR, { taskId: child.id, revision: child.revision })
      const rebased = (await tasks.detail(ACTOR, root.id)).task
      expect((await tasks.setStatus(ACTOR, { taskId: root.id, revision: rebased.revision, status: "done" })).task.status).toBe("done")
    })

    test("reopening a child requires an open parent", async () => {
      const root = (await tasks.create(ACTOR, draft())).task
      const child = (await tasks.create(ACTOR, draft({ parentTaskId: root.id }))).task
      const doneChild = (await tasks.setStatus(ACTOR, { taskId: child.id, revision: child.revision, status: "done" })).task
      const rebased = (await tasks.detail(ACTOR, root.id)).task
      await tasks.setStatus(ACTOR, { taskId: root.id, revision: rebased.revision, status: "done" })

      expect(
        (await refusalOf(() => tasks.setStatus(ACTOR, { taskId: child.id, revision: doneChild.revision, status: "doing" }))).code,
      ).toBe("conflict")
    })

    test("a status change bumps the parent's child-set revision", async () => {
      const root = (await tasks.create(ACTOR, draft())).task
      const child = (await tasks.create(ACTOR, draft({ parentTaskId: root.id }))).task
      const moved = await tasks.setStatus(ACTOR, { taskId: child.id, revision: child.revision, status: "doing" })
      expect(moved.parent?.childSetRevision).toBe(2)
    })
  })

  describe("edit, reparent, archive", () => {
    test("an edit refuses a stale revision and reports the current task", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      await tasks.edit(ACTOR, { taskId: task.id, revision: 1, title: "First", description: "", workspaceId: null })
      const detail = await refusalOf(() =>
        tasks.edit(ACTOR, { taskId: task.id, revision: 1, title: "Second", description: "", workspaceId: null }),
      )
      expect(detail.code).toBe("stale_revision")
      expect(detail.currentTask?.title).toBe("First")
    })

    test("a linked task keeps its workspace and its project", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      await tasks.start(ACTOR, task.id, start(task))
      const linked = (await tasks.detail(ACTOR, task.id)).task

      expect(
        fieldReasons(
          await refusalOf(() =>
            tasks.edit(ACTOR, { taskId: task.id, revision: linked.revision, title: task.title, description: "", workspaceId: "workspace-two" }),
          ),
        ),
      ).toEqual({ workspaceId: "not_allowed" })

      expect(
        fieldReasons(
          await refusalOf(() =>
            tasks.reparent(ACTOR, { taskId: task.id, revision: linked.revision, parentTaskId: null, projectId: "project-beta" }),
          ),
        ),
      ).toEqual({ projectId: "not_allowed" })
    })

    test("a task with children can neither change project nor become a child", async () => {
      const root = (await tasks.create(ACTOR, draft())).task
      await tasks.create(ACTOR, draft({ parentTaskId: root.id }))
      const other = (await tasks.create(ACTOR, draft())).task
      const current = (await tasks.detail(ACTOR, root.id)).task

      expect(
        fieldReasons(
          await refusalOf(() => tasks.reparent(ACTOR, { taskId: root.id, revision: current.revision, parentTaskId: null, projectId: "project-beta" })),
        ),
      ).toEqual({ projectId: "not_allowed" })
      expect(
        fieldReasons(
          await refusalOf(() => tasks.reparent(ACTOR, { taskId: root.id, revision: current.revision, parentTaskId: other.id, projectId: PROJECT })),
        ),
      ).toEqual({ parentTaskId: "not_allowed" })
    })

    test("reparenting moves the child set of both parents", async () => {
      const first = (await tasks.create(ACTOR, draft({ title: "First parent" }))).task
      const second = (await tasks.create(ACTOR, draft({ title: "Second parent" }))).task
      const child = (await tasks.create(ACTOR, draft({ parentTaskId: first.id }))).task
      const rebased = (await tasks.detail(ACTOR, child.id)).task

      const moved = await tasks.reparent(ACTOR, {
        taskId: child.id,
        revision: rebased.revision,
        parentTaskId: second.id,
        projectId: PROJECT,
      })
      expect(moved.task.parentTaskId).toBe(second.id)
      expect(moved.parent?.id).toBe(second.id)
      expect((await tasks.children(ACTOR, first.id, { cursor: null, limit: 50, includeArchived: true })).items).toHaveLength(0)
      expect((await tasks.children(ACTOR, second.id, { cursor: null, limit: 50, includeArchived: true })).items).toHaveLength(1)
      expect((await tasks.detail(ACTOR, first.id)).task.childSetRevision).toBe(2)
    })

    test("archive requires the children to be archived first and performs no session work", async () => {
      const root = (await tasks.create(ACTOR, draft())).task
      const child = (await tasks.create(ACTOR, draft({ parentTaskId: root.id }))).task
      const current = (await tasks.detail(ACTOR, root.id)).task

      expect((await refusalOf(() => tasks.archive(ACTOR, { taskId: root.id, revision: current.revision }))).code).toBe("conflict")
      await tasks.archive(ACTOR, { taskId: child.id, revision: child.revision })
      const rebased = (await tasks.detail(ACTOR, root.id)).task
      const archived = await tasks.archive(ACTOR, { taskId: root.id, revision: rebased.revision })
      expect(archived.task.archivedAt).not.toBeNull()
      expect(bridge.starts).toHaveLength(0)
    })

    test("an archived task refuses every mutation but restore", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      const archived = (await tasks.archive(ACTOR, { taskId: task.id, revision: task.revision })).task
      expect(
        (await refusalOf(() => tasks.edit(ACTOR, { taskId: task.id, revision: archived.revision, title: "x", description: "", workspaceId: null })))
          .code,
      ).toBe("conflict")
      const restored = await tasks.restore(ACTOR, { taskId: task.id, revision: archived.revision })
      expect(restored.task.archivedAt).toBeNull()
    })

    test("restoring a child under a done parent is refused", async () => {
      const root = (await tasks.create(ACTOR, draft())).task
      const child = (await tasks.create(ACTOR, draft({ parentTaskId: root.id }))).task
      const archivedChild = (await tasks.archive(ACTOR, { taskId: child.id, revision: child.revision })).task
      const rebased = (await tasks.detail(ACTOR, root.id)).task
      await tasks.setStatus(ACTOR, { taskId: root.id, revision: rebased.revision, status: "done" })

      expect((await refusalOf(() => tasks.restore(ACTOR, { taskId: child.id, revision: archivedChild.revision }))).code).toBe("conflict")
    })
  })

  describe("reads", () => {
    test("listing requires read access to the project it names", async () => {
      await tasks.create(ACTOR, draft())
      authorization.denyProject(PROJECT)
      expect(
        (await refusalOf(() => tasks.list(ACTOR, { projectId: PROJECT, status: null, parent: "any", cursor: null, limit: 50, includeArchived: false })))
          .code,
      ).toBe("forbidden")
    })

    test("a list row carries no description, only whether there is one", async () => {
      await tasks.create(ACTOR, draft({ description: "The long form" }))
      const page = await tasks.list(ACTOR, { projectId: PROJECT, status: null, parent: "any", cursor: null, limit: 50, includeArchived: false })
      expect(page.items[0]).toMatchObject({ hasDescription: true })
      expect(page.items[0]).not.toHaveProperty("description")
    })

    test("root filtering hides children", async () => {
      const root = (await tasks.create(ACTOR, draft())).task
      await tasks.create(ACTOR, draft({ parentTaskId: root.id }))
      const roots = await tasks.list(ACTOR, { projectId: PROJECT, status: null, parent: "root", cursor: null, limit: 50, includeArchived: false })
      expect(roots.items.map((row) => row.id)).toEqual([root.id])
    })

    test("another scope sees no task at all", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      expect((await refusalOf(() => tasks.detail(OTHER_SCOPE, task.id))).code).toBe("not_found")
    })

    test("detail hides a link whose session the actor may not open", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      await tasks.start(ACTOR, task.id, start(task))
      expect((await tasks.detail(ACTOR, task.id)).links).toHaveLength(1)

      authorization.denySession("session-1")
      expect((await tasks.detail(ACTOR, task.id)).links).toHaveLength(0)
    })

    test("a link reports liveness read from the bridge, never a stored flag", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      await tasks.start(ACTOR, task.id, start(task))
      expect((await tasks.detail(ACTOR, task.id)).links[0]?.liveness).toBe("live")

      bridge.setState("session-1", "deleted")
      expect((await tasks.detail(ACTOR, task.id)).links[0]?.liveness).toBe("deleted")
    })

    test("a link carries preset provenance and no preset content", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      await tasks.start(ACTOR, task.id, start(task))
      const view = (await tasks.detail(ACTOR, task.id)).links[0]
      expect(view).toMatchObject({ presetId: preset.id, presetRevision: preset.revision, presetNameAtStart: preset.name })
      expect(JSON.stringify(view)).not.toContain(preset.instructions)
    })
  })

  describe("start", () => {
    test("previewing asks the bridge and writes nothing", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      const preview = await tasks.startPreview(ACTOR, task.id, {
        taskRevision: task.revision,
        presetId: preset.id,
        presetRevision: preset.revision,
        slot: "primary",
        attempt: 1,
        continueFromPrevious: false,
      })
      expect(preview.placement).toBe("local")
      expect(bridge.previews).toHaveLength(1)
      expect((await tasks.detail(ACTOR, task.id)).links).toHaveLength(0)
    })

    test("a slot the preset does not configure is refused", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      const detail = await refusalOf(() => tasks.start(ACTOR, task.id, start(task, { slot: "planning" })))
      expect(fieldReasons(detail)).toEqual({ slot: "unknown_value" })
    })

    test("an archived preset cannot start a session, and a stale one is named as stale", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      const presets = createPresetsService({ store, clock: fakeClock(), ids: fakeIds(), capabilities: fakeCapabilities() })
      const archived = await presets.archive(ACTOR, { presetId: preset.id, revision: preset.revision })

      const stale = await refusalOf(() => tasks.start(ACTOR, task.id, start(task, { presetRevision: preset.revision })))
      expect(stale.code).toBe("stale_revision")
      expect(stale.currentPreset?.archivedAt).not.toBeNull()

      const refused = await refusalOf(() => tasks.start(ACTOR, task.id, start(task, { presetRevision: archived.revision })))
      expect(refused.code).toBe("conflict")
      expect(bridge.starts).toHaveLength(0)
    })

    test("the first start links attempt 1 and the bridge receives the task and preset", async () => {
      const task = (await tasks.create(ACTOR, draft({ description: "Do it well" }))).task
      const started = await tasks.start(ACTOR, task.id, start(task, { handoffText: "Pick up from the spike" }))
      expect(started.created).toBe(true)
      expect(started.link).toMatchObject({ attempt: 1, slot: "primary", liveness: "live" })
      expect(bridge.starts[0]).toMatchObject({
        previousSession: null,
        task: { id: task.id },
        preset: { id: preset.id },
      })
      expect(bridge.delivered).toMatchObject([{
        handoffText: "Pick up from the spike",
        task: { id: task.id },
        slot: "primary",
        attempt: 1,
        session: started.link.sessionRef,
      }])
    })

    test("the session a start is asked from reaches the bridge, and what the bridge says started it is what the link records", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      const from = { sessionId: "ses_caller", workspaceId: "workspace-1" }
      await tasks.startPreview(ACTOR, task.id, {
        taskRevision: task.revision,
        presetId: preset.id,
        presetRevision: preset.revision,
        slot: "primary",
        attempt: 1,
        continueFromPrevious: false,
        startedFrom: from,
      })
      expect(bridge.previews[0]?.startedFrom).toEqual(from)
      await tasks.start(ACTOR, task.id, start(task, { startedFrom: from }))
      expect(bridge.starts[0]?.startedFrom).toEqual(from)
      const link = await store.links.getCurrent(ACTOR.scopeId, task.id, "primary")
      expect(link?.startedBy).toBe("person")
      expect(link?.startedFrom).toBeNull()
    })

    test("re-requesting the live attempt returns the same session without starting another", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      const first = await tasks.start(ACTOR, task.id, start(task))
      const linked = (await tasks.detail(ACTOR, task.id)).task
      const again = await tasks.start(ACTOR, task.id, start(task, { taskRevision: linked.revision }))
      expect(again.created).toBe(false)
      expect(again.link.sessionRef).toEqual(first.link.sessionRef)
      expect(bridge.starts).toHaveLength(1)
    })

    test("the link insertion advances the task, so an edit that missed the link cannot commit", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      await tasks.start(ACTOR, task.id, start(task))

      expect((await tasks.detail(ACTOR, task.id)).task.revision).toBe(task.revision + 1)
      const stale = await refusalOf(() =>
        tasks.edit(ACTOR, { taskId: task.id, revision: task.revision, title: "Renamed", description: "", workspaceId: null }),
      )
      expect(stale.code).toBe("stale_revision")
    })

    test("a task whose workspace changed while the session was being created does not acquire it", async () => {
      const task = (await tasks.create(ACTOR, draft({ workspaceId: "workspace-one" }))).task
      const moving = {
        ...bridge,
        start: async (command: Parameters<FakeBridge["start"]>[0]) => {
          await tasks.edit(ACTOR, {
            taskId: task.id,
            revision: task.revision,
            title: task.title,
            description: task.description,
            workspaceId: "workspace-two",
          })
          return bridge.start(command)
        },
      }
      const racing = createTasksService({ store, clock: fakeClock(), ids: fakeIds(), authorization, bridge: moving })

      expect((await refusalOf(() => racing.start(ACTOR, task.id, start(task)))).code).toBe("conflict")
      expect((await store.links.listByTask(ACTOR.scopeId, task.id)).length).toBe(0)
      expect((await tasks.detail(ACTOR, task.id)).task.workspaceId).toBe("workspace-two")
    })

    test("a session the actor may not open is hidden from detail and refuses Start, Continue and preview alike", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      await tasks.start(ACTOR, task.id, start(task))
      const linked = (await tasks.detail(ACTOR, task.id)).task

      authorization.denySession("session-1")
      expect((await tasks.detail(ACTOR, task.id)).links).toHaveLength(0)

      const restart = await refusalOf(() => tasks.start(ACTOR, task.id, start(task, { taskRevision: linked.revision })))
      expect(restart.code).toBe("forbidden")

      bridge.setState("session-1", "archived")
      const continued = await refusalOf(() =>
        tasks.start(ACTOR, task.id, start(task, { taskRevision: linked.revision, attempt: 2, continueFromPrevious: true })),
      )
      expect(continued.code).toBe("forbidden")

      const previewed = await refusalOf(() =>
        tasks.startPreview(ACTOR, task.id, {
          taskRevision: linked.revision,
          presetId: preset.id,
          presetRevision: preset.revision,
          slot: "primary",
          attempt: 2,
          continueFromPrevious: true,
        }),
      )
      expect(previewed.code).toBe("forbidden")
      expect(bridge.starts).toHaveLength(1)
      expect(bridge.previews).toHaveLength(0)
    })

    test("a live slot re-requested with another configuration is refused, not answered with its session", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      await tasks.start(ACTOR, task.id, start(task))
      const linked = (await tasks.detail(ACTOR, task.id)).task

      const other = await createPresetsService({
        store,
        clock: fakeClock(),
        ids: { presetId: () => "preset-other", taskId: () => "task-other" },
        capabilities: fakeCapabilities(),
      }).create(
        ACTOR,
        presetDraft({
          name: "Other preset",
          configurations: { primary: primaryConfiguration({ model: { providerID: "anthropic", modelID: "claude-opus" } }) },
        }),
      )

      const detail = await refusalOf(() =>
        tasks.start(ACTOR, task.id, start(task, { taskRevision: linked.revision, presetId: other.id, presetRevision: other.revision })),
      )
      expect(detail.code).toBe("conflict")
      expect(bridge.starts).toHaveLength(1)
      expect((await store.links.getCurrent(ACTOR.scopeId, task.id, "primary"))?.presetId).toBe(preset.id)
    })

    test("the next attempt is refused while the current session is live", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      await tasks.start(ACTOR, task.id, start(task))
      const linked = (await tasks.detail(ACTOR, task.id)).task
      const detail = await refusalOf(() => tasks.start(ACTOR, task.id, start(task, { taskRevision: linked.revision, attempt: 2 })))
      expect(detail.code).toBe("conflict")
      expect(bridge.starts).toHaveLength(1)
    })

    test("a start again is accepted once the owner reports the session archived", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      await tasks.start(ACTOR, task.id, start(task))
      const linked = (await tasks.detail(ACTOR, task.id)).task
      bridge.setState("session-1", "archived")
      bridge.nextSession("session-2")

      expect(
        (await refusalOf(() => tasks.start(ACTOR, task.id, start(task, { taskRevision: linked.revision, attempt: 1 })))).code,
      ).toBe("conflict")

      const again = await tasks.start(
        ACTOR,
        task.id,
        start(task, { taskRevision: linked.revision, attempt: 2, continueFromPrevious: true }),
      )
      expect(again.created).toBe(true)
      expect(again.link.attempt).toBe(2)
      expect(again.link.continuedFrom?.sessionId).toBe("session-1")
      expect((await tasks.detail(ACTOR, task.id)).links.map((link) => link.attempt)).toEqual([2, 1])
    })

    test("the first attempt of a fresh slot must be 1", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      expect((await refusalOf(() => tasks.start(ACTOR, task.id, start(task, { attempt: 2 })))).code).toBe("conflict")
    })

    test("two slots of one task hold separate sessions", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      await tasks.start(ACTOR, task.id, start(task))
      const linked = (await tasks.detail(ACTOR, task.id)).task
      bridge.nextSession("session-review")
      const review = await tasks.start(ACTOR, task.id, start(task, { taskRevision: linked.revision, slot: "review" }))
      expect(review.link.sessionRef.sessionId).toBe("session-review")
      expect((await tasks.detail(ACTOR, task.id)).links).toHaveLength(2)
    })

    test("a bridge refusal is surfaced and leaves no link", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      bridge.refuseStart("This host cannot reach that workspace")
      const detail = await refusalOf(() => tasks.start(ACTOR, task.id, start(task)))
      expect(detail.code).toBe("unsupported")
      expect((await tasks.detail(ACTOR, task.id)).links).toHaveLength(0)
    })

    test("a task archived while the session was being created does not acquire it", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      const archiving = {
        ...bridge,
        start: async (command: Parameters<FakeBridge["start"]>[0]) => {
          await tasks.archive(ACTOR, { taskId: task.id, revision: task.revision })
          return bridge.start(command)
        },
      }
      const racing = createTasksService({ store, clock: fakeClock(), ids: fakeIds(), authorization, bridge: archiving })
      expect((await refusalOf(() => racing.start(ACTOR, task.id, start(task)))).code).toBe("conflict")
      expect((await store.links.listByTask(ACTOR.scopeId, task.id)).length).toBe(0)
    })

    test("authority lost while the session was being created refuses the link", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      const revoking = {
        ...bridge,
        start: async (command: Parameters<FakeBridge["start"]>[0]) => {
          authorization.denyProject(PROJECT)
          return bridge.start(command)
        },
      }
      const racing = createTasksService({ store, clock: fakeClock(), ids: fakeIds(), authorization, bridge: revoking })
      expect((await refusalOf(() => racing.start(ACTOR, task.id, start(task)))).code).toBe("forbidden")
      expect((await store.links.listByTask(ACTOR.scopeId, task.id)).length).toBe(0)
    })

    test("an origin lost at commit is refused as a conflict rather than escaping as a fault", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      const losing: TasksStorePort = {
        ...store,
        transaction: (work) =>
          store.transaction(async (operations) => {
            await work(operations)
            throw new TasksStoreConflict("link-conflict", "the origin was taken before this unit committed")
          }),
      }
      const racing = createTasksService({ store: losing, clock: fakeClock(), ids: fakeIds(), authorization, bridge })

      const detail = await refusalOf(() => racing.start(ACTOR, task.id, start(task)))
      expect(detail.code).toBe("conflict")
      expect((await store.links.listByTask(ACTOR.scopeId, task.id)).length).toBe(0)
    })

    // Two clients reach the bridge before either has saved a link: the loser
    // must not replace the session the winner attached to the origin.
    test("a second session created for one origin conflicts instead of replacing it", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      const racing = {
        ...bridge,
        start: async (command: Parameters<FakeBridge["start"]>[0]) => {
          await store.links.insert({
            scopeId: ACTOR.scopeId,
            taskId: task.id,
            slot: "primary",
            attempt: 1,
            sessionRef: { sessionId: "session-winner", workspaceId: null },
            continuedFrom: null,
            presetId: preset.id,
            presetRevision: preset.revision,
            presetNameAtStart: preset.name,
            configurationDigest: await startConfigurationDigest({ preset, slot: "primary" }),
            handoffText: null,
            startedFrom: null,
            startedBy: "person",
            placement: "local",
            createdAt: 10,
          })
          return bridge.start(command)
        },
      }
      const loser = createTasksService({ store, clock: fakeClock(), ids: fakeIds(), authorization, bridge: racing })
      expect((await refusalOf(() => loser.start(ACTOR, task.id, start(task)))).code).toBe("conflict")
      expect((await store.links.getCurrent(ACTOR.scopeId, task.id, "primary"))?.sessionRef.sessionId).toBe("session-winner")
    })

    // The signed session authority answers from the session row, so a deleted
    // session is refused rather than reported as gone. Start again has to
    // stand on the liveness reading instead of on a grant to open what it
    // replaces.
    const rowBackedAuthorization = (): TasksAuthorizationPort => ({
      authorizeProject: (actor, projectId, access) => authorization.authorizeProject(actor, projectId, access),
      async authorizeSessionOpen(actor, session) {
        const [reading] = await bridge.sessionState([
          { scopeId: actor.scopeId, taskId: "", slot: "primary", attempt: 1, sessionRef: session },
        ])
        if (!reading || reading.state === "deleted") return false
        return authorization.authorizeSessionOpen(actor, session)
      },
    })

    test("a deleted session admits the next attempt, and a live one this actor cannot open still refuses it", async () => {
      const rowBacked = createTasksService({
        store,
        clock: fakeClock(),
        ids: fakeIds(),
        authorization: rowBackedAuthorization(),
        bridge,
      })
      const task = (await rowBacked.create(ACTOR, draft())).task
      await rowBacked.start(ACTOR, task.id, start(task))
      const linked = (await rowBacked.detail(ACTOR, task.id)).task

      bridge.setState("session-1", "deleted")
      bridge.nextSession("session-2")
      // The next attempt's number comes from the task's links, so the attempt
      // whose session is gone has to stay in them.
      expect((await rowBacked.detail(ACTOR, task.id)).links).toMatchObject([{ attempt: 1, liveness: "deleted" }])

      const again = await rowBacked.start(ACTOR, task.id, start(task, { taskRevision: linked.revision, attempt: 2 }))
      expect(again.created).toBe(true)
      expect(again.link).toMatchObject({ attempt: 2, sessionRef: { sessionId: "session-2" } })

      authorization.denySession("session-2")
      const replaced = (await rowBacked.detail(ACTOR, task.id)).task
      const detail = await refusalOf(() =>
        rowBacked.start(ACTOR, task.id, start(task, { taskRevision: replaced.revision, attempt: 2 })),
      )
      expect(detail.code).toBe("forbidden")
    })

    test("a session grant lost between preview and start never reaches the bridge as a transcript to copy", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      await tasks.start(ACTOR, task.id, start(task))
      const linked = (await tasks.detail(ACTOR, task.id)).task
      bridge.setState("session-1", "archived")

      const previewed = await tasks.startPreview(ACTOR, task.id, {
        taskRevision: linked.revision,
        presetId: preset.id,
        presetRevision: preset.revision,
        slot: "primary",
        attempt: 2,
        continueFromPrevious: true,
      })
      expect(previewed.previousTranscriptReadable).toBe(true)

      // The host reads the previous transcript, so the grant has to hold at the
      // call: this authority answers the slot read and is gone by the time
      // Continue would hand the bridge a session to copy.
      let grants = 1
      const revoked: TasksAuthorizationPort = {
        authorizeProject: (actor, projectId, access) => authorization.authorizeProject(actor, projectId, access),
        authorizeSessionOpen: async (actor, session) =>
          grants-- > 0 ? authorization.authorizeSessionOpen(actor, session) : false,
      }
      const racing = createTasksService({ store, clock: fakeClock(), ids: fakeIds(), authorization: revoked, bridge })

      const detail = await refusalOf(() =>
        racing.start(ACTOR, task.id, start(task, { taskRevision: linked.revision, attempt: 2, continueFromPrevious: true })),
      )
      expect(detail.code).toBe("forbidden")
      expect(bridge.starts).toHaveLength(1)
    })

    test("a preset edited while the session was being created leaves no link, and the session it made is given back", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      const presets = createPresetsService({ store, clock: fakeClock(), ids: fakeIds(), capabilities: fakeCapabilities() })
      const editing: FakeBridge = {
        ...bridge,
        start: async (command: Parameters<FakeBridge["start"]>[0]) => {
          await presets.edit(ACTOR, {
            ...slotted("review"),
            presetId: preset.id,
            revision: preset.revision,
            name: "Rewritten",
            instructions: "Ignore the code and rewrite it.",
          })
          return bridge.start(command)
        },
      }
      const racing = createTasksService({ store, clock: fakeClock(), ids: fakeIds(), authorization, bridge: editing })

      expect((await refusalOf(() => racing.start(ACTOR, task.id, start(task)))).code).toBe("conflict")
      expect((await store.links.listByTask(ACTOR.scopeId, task.id)).length).toBe(0)
      expect(bridge.abandoned).toMatchObject([{ attempt: 1, slot: "primary", sessionRef: { sessionId: "session-1" } }])

      // The origin is free, so the same attempt starts again under the preset
      // that is now current instead of the user being told attempt 1 is taken.
      const current = await store.presets.get(ACTOR.scopeId, preset.id)
      expect(current?.revision).toBe(preset.revision + 1)
      bridge.nextSession("session-2")
      const retried = await tasks.start(ACTOR, task.id, start(task, { presetRevision: current?.revision ?? 0 }))
      expect(retried).toMatchObject({
        created: true,
        link: { attempt: 1, sessionRef: { sessionId: "session-2" }, presetRevision: current?.revision },
      })
      expect((await store.links.listByTask(ACTOR.scopeId, task.id)).length).toBe(1)
    })

    test("a settlement refused by a link another client already committed leaves that client's session alone", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      const planting: FakeBridge = {
        ...bridge,
        start: async (command: Parameters<FakeBridge["start"]>[0]) => {
          const started = await bridge.start(command)
          if (!started.ok) return started
          await store.links.insert({
            scopeId: ACTOR.scopeId,
            taskId: task.id,
            slot: "primary",
            attempt: 1,
            sessionRef: started.session.sessionRef,
            continuedFrom: null,
            presetId: preset.id,
            presetRevision: preset.revision,
            presetNameAtStart: preset.name,
            configurationDigest: "another-configuration",
            handoffText: null,
            startedFrom: null,
            startedBy: "person",
            placement: "local",
            createdAt: 10,
          })
          return started
        },
      }
      const loser = createTasksService({ store, clock: fakeClock(), ids: fakeIds(), authorization, bridge: planting })

      expect((await refusalOf(() => loser.start(ACTOR, task.id, start(task)))).code).toBe("conflict")
      expect(bridge.abandoned).toHaveLength(0)
      expect((await store.links.getCurrent(ACTOR.scopeId, task.id, "primary"))?.sessionRef.sessionId).toBe("session-1")
    })

    test("a grant revoked while the host resolves its target stops the transcript read inside the bridge", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      await tasks.start(ACTOR, task.id, start(task))
      const linked = (await tasks.detail(ACTOR, task.id)).task
      bridge.setState("session-1", "archived")

      // The grant answers every read the service makes and is gone by the time
      // the host has resolved the workspace it would read the transcript in.
      let resolvingTarget = false
      const revoked: TasksAuthorizationPort = {
        authorizeProject: (actor, projectId, access) => authorization.authorizeProject(actor, projectId, access),
        authorizeSessionOpen: async (actor, session) =>
          resolvingTarget ? false : authorization.authorizeSessionOpen(actor, session),
      }
      const resolving: FakeBridge = {
        ...bridge,
        start: async (command: Parameters<FakeBridge["start"]>[0]) => {
          resolvingTarget = true
          await Promise.resolve()
          return bridge.start(command)
        },
      }
      const racing = createTasksService({ store, clock: fakeClock(), ids: fakeIds(), authorization: revoked, bridge: resolving })

      const detail = await refusalOf(() =>
        racing.start(ACTOR, task.id, start(task, { taskRevision: linked.revision, attempt: 2, continueFromPrevious: true })),
      )
      expect(detail.code).toBe("forbidden")
      expect(bridge.transcriptReads).toHaveLength(0)
      expect((await store.links.listByTask(ACTOR.scopeId, task.id)).length).toBe(1)
    })

    test("an existing link answers this Start only when it names the same session, configuration and workspace", async () => {
      const digest = await startConfigurationDigest({ preset, slot: "primary" })
      const planting = (task: Task, overrides: Partial<TaskSessionLink>): FakeBridge => ({
        ...bridge,
        start: async (command: Parameters<FakeBridge["start"]>[0]) => {
          await store.links.insert({
            scopeId: ACTOR.scopeId,
            taskId: task.id,
            slot: "primary",
            attempt: 1,
            sessionRef: { sessionId: "session-1", workspaceId: "workspace-1" },
            continuedFrom: null,
            presetId: preset.id,
            presetRevision: preset.revision,
            presetNameAtStart: preset.name,
            configurationDigest: digest,
            handoffText: null,
            startedFrom: null,
            startedBy: "person",
            placement: "local",
            createdAt: 10,
            ...overrides,
          })
          return bridge.start(command)
        },
      })
      const racing = (task: Task, overrides: Partial<TaskSessionLink>) =>
        createTasksService({ store, clock: fakeClock(), ids: fakeIds(), authorization, bridge: planting(task, overrides) })

      const reconfigured = (await tasks.create(ACTOR, draft())).task
      expect(
        (await refusalOf(() =>
          racing(reconfigured, { configurationDigest: "another-configuration" }).start(
            ACTOR,
            reconfigured.id,
            start(reconfigured),
          ),
        )).code,
      ).toBe("conflict")

      const elsewhere = (await tasks.create(ACTOR, draft())).task
      expect(
        (await refusalOf(() =>
          racing(elsewhere, { sessionRef: { sessionId: "session-1", workspaceId: "workspace-two" } }).start(
            ACTOR,
            elsewhere.id,
            start(elsewhere),
          ),
        )).code,
      ).toBe("conflict")

      const same = (await tasks.create(ACTOR, draft())).task
      const answered = await racing(same, {}).start(ACTOR, same.id, start(same))
      expect(answered.created).toBe(false)
      expect(answered.link.sessionRef).toEqual({ sessionId: "session-1", workspaceId: "workspace-1" })
      // The link that answered is the one already stored, so this settlement
      // writes nothing: the task keeps the revision the winner left it at.
      expect((await store.tasks.get(ACTOR.scopeId, same.id))?.revision).toBe(same.revision)
      expect(bridge.abandoned).toHaveLength(0)
    })

    test("a link whose first message never landed reports pending, and one Start sends the text it was started with", async () => {
      const task = (await tasks.create(ACTOR, draft())).task
      bridge.refuseHandoff("the workspace runtime would not say whether the task was already sent")

      const refused = await refusalOf(() =>
        tasks.start(ACTOR, task.id, start(task, { handoffText: "Start at the failing import test." })),
      )
      expect(refused.code).toBe("conflict")
      expect((await store.links.getCurrent(ACTOR.scopeId, task.id, "primary"))?.sessionRef.sessionId).toBe("session-1")
      expect(bridge.delivered).toHaveLength(0)

      // What the reader sees after the crash: a live session whose task was
      // never handed to it, which is the state the recovery Start acts on.
      const stranded = await tasks.detail(ACTOR, task.id)
      expect(stranded.links).toMatchObject([{ attempt: 1, liveness: "live", handoff: "pending" }])

      bridge.refuseHandoff(null)
      const linked = stranded.task
      const retried = await tasks.start(
        ACTOR,
        task.id,
        start(task, { taskRevision: linked.revision, handoffText: "A different note." }),
      )
      expect(retried).toMatchObject({ created: false, link: { sessionRef: { sessionId: "session-1" }, handoff: "sent" } })
      expect(bridge.delivered).toHaveLength(1)
      // The message is the one the link was committed with, not the one this
      // request happened to carry.
      expect(bridge.delivered[0]?.handoffText).toBe("Start at the failing import test.")

      const third = await tasks.start(ACTOR, task.id, start(task, { taskRevision: linked.revision }))
      expect(third).toMatchObject({ created: false, link: { handoff: "sent" } })
      expect(bridge.delivered).toHaveLength(1)
      expect(bridge.handoffs).toHaveLength(2)
      expect(bridge.starts).toHaveLength(1)
      expect((await tasks.detail(ACTOR, task.id)).links).toMatchObject([{ handoff: "sent" }])
    })
  })
})
