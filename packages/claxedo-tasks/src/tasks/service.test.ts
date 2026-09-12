import { beforeEach, describe, expect, test } from "bun:test"
import { createTasksCommands } from "../commands"
import type { Preset, StartRequest, Task } from "../contracts"
import { createPresetsService } from "../presets/service"
import { startConfigurationDigest } from "../start"
import { createMemoryTasksStore } from "../stores/memory"
import {
  ACTOR,
  OTHER_SCOPE,
  fakeAuthorization,
  fakeBridge,
  fakeCapabilities,
  fakeClock,
  fakeIds,
  fieldReasons,
  presetDraft,
  primaryConfiguration,
  refusalOf,
  slotted,
  type FakeAuthorization,
  type FakeBridge,
} from "../test-support/harness"
import type { TasksStoreOperations, TasksStorePort } from "../ports/store"
import { createTasksService, type TasksService } from "./service"

const PROJECT = "project-alpha"

function draft(overrides: Partial<Task> = {}) {
  return {
    projectId: overrides.projectId ?? PROJECT,
    title: overrides.title ?? "Ship the thing",
    description: overrides.description ?? "",
    workspaceId: overrides.workspaceId ?? null,
    parentTaskId: overrides.parentTaskId ?? null,
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
  })

  describe("creation and the child set", () => {
    test("creates a root task in todo", async () => {
      const { task, parent } = await tasks.create(ACTOR, draft())
      expect(task).toMatchObject({ revision: 1, status: "todo", parentTaskId: null, childSetRevision: 0 })
      expect(parent).toBeNull()
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
        handoffText: "Pick up from the spike",
        previousSession: null,
        task: { id: task.id },
        preset: { id: preset.id },
      })
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
            createdAt: 10,
          })
          return bridge.start(command)
        },
      }
      const loser = createTasksService({ store, clock: fakeClock(), ids: fakeIds(), authorization, bridge: racing })
      expect((await refusalOf(() => loser.start(ACTOR, task.id, start(task)))).code).toBe("conflict")
      expect((await store.links.getCurrent(ACTOR.scopeId, task.id, "primary"))?.sessionRef.sessionId).toBe("session-winner")
    })
  })
})
