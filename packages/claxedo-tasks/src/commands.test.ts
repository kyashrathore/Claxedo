import { beforeEach, describe, expect, test } from "bun:test"
import { createTasksCommands, type TasksCommands } from "./commands"
import type { TasksCommand } from "./contracts"
import { createMemoryTasksStore } from "./stores/memory"
import {
  ACTOR,
  OTHER_ACTOR,
  fakeAuthorization,
  fakeBridge,
  fakeCapabilities,
  fakeClock,
  fakeIds,
  presetDraft,
  refusalOf,
  type FakeAuthorization,
} from "./test-support/harness"
import type { TasksStorePort } from "./ports/store"

const PROJECT = "project-alpha"

const createTask: TasksCommand = {
  type: "task.create",
  input: { projectId: PROJECT, title: "Ship the thing", description: "", workspaceId: null, parentTaskId: null },
}

describe("tasks commands", () => {
  let store: TasksStorePort
  let authorization: FakeAuthorization
  let commands: TasksCommands

  beforeEach(() => {
    store = createMemoryTasksStore()
    authorization = fakeAuthorization()
    commands = createTasksCommands({
      store,
      clock: fakeClock(),
      ids: fakeIds(),
      capabilities: fakeCapabilities(),
      authorization,
      bridge: fakeBridge(),
    })
  })

  test("runs a preset command and a task command through one closed union", async () => {
    const preset = await commands.execute(ACTOR, {
      clientRequestId: "request-preset",
      command: { type: "preset.create", input: presetDraft() },
    })
    expect(preset.result.type).toBe("preset.create")
    expect(preset.replayed).toBe(false)

    const task = await commands.execute(ACTOR, { clientRequestId: "request-task", command: createTask })
    expect(task.result).toMatchObject({ type: "task.create", task: { title: "Ship the thing", revision: 1 } })
  })

  test("the same request id replays the committed result instead of running again", async () => {
    const first = await commands.execute(ACTOR, { clientRequestId: "request-once", command: createTask })
    const second = await commands.execute(ACTOR, { clientRequestId: "request-once", command: createTask })

    expect(second.replayed).toBe(true)
    expect(second.result).toEqual(first.result)
    const page = await store.tasks.list(ACTOR.scopeId, {
      projectId: PROJECT,
      status: null,
      parent: "any",
      cursor: null,
      limit: 50,
      includeArchived: false,
    })
    expect(page.items).toHaveLength(1)
  })

  test("a different command under a committed request id is a conflict", async () => {
    await commands.execute(ACTOR, { clientRequestId: "request-once", command: createTask })
    const detail = await refusalOf(() =>
      commands.execute(ACTOR, {
        clientRequestId: "request-once",
        command: { ...createTask, input: { ...createTask.input, title: "Something else" } },
      }),
    )
    expect(detail.code).toBe("conflict")
  })

  test("key order in the request does not make it a different command", async () => {
    await commands.execute(ACTOR, { clientRequestId: "request-once", command: createTask })
    const reordered: TasksCommand = {
      type: "task.create",
      input: { title: "Ship the thing", parentTaskId: null, workspaceId: null, description: "", projectId: PROJECT },
    }
    expect((await commands.execute(ACTOR, { clientRequestId: "request-once", command: reordered })).replayed).toBe(true)
  })

  test("a replay is refused once the actor loses access to what it committed", async () => {
    await commands.execute(ACTOR, { clientRequestId: "request-once", command: createTask })
    authorization.denyProject(PROJECT)
    expect((await refusalOf(() => commands.execute(ACTOR, { clientRequestId: "request-once", command: createTask }))).code).toBe(
      "forbidden",
    )
  })

  test("a preset replay is refused for another owner in the same scope", async () => {
    await commands.execute(ACTOR, {
      clientRequestId: "request-preset",
      command: { type: "preset.create", input: presetDraft() },
    })
    const detail = await refusalOf(() =>
      commands.execute(OTHER_ACTOR, { clientRequestId: "request-preset", command: { type: "preset.create", input: presetDraft() } }),
    )
    expect(detail.code).toBe("not_found")
  })

  test("a request id is free again after the command it named was refused", async () => {
    const created = await commands.execute(ACTOR, { clientRequestId: "request-task", command: createTask })
    const task = created.result.type === "task.create" ? created.result.task : undefined

    const stale = await refusalOf(() =>
      commands.execute(ACTOR, {
        clientRequestId: "request-retry",
        command: { type: "task.edit", input: { taskId: task?.id ?? "", revision: 99, title: "Renamed", description: "", workspaceId: null } },
      }),
    )
    expect(stale.code).toBe("stale_revision")
    expect(await store.receipts.get(ACTOR.scopeId, "request-retry")).toBeUndefined()

    const retried = await commands.execute(ACTOR, {
      clientRequestId: "request-retry",
      command: { type: "task.edit", input: { taskId: task?.id ?? "", revision: 1, title: "Renamed", description: "", workspaceId: null } },
    })
    expect(retried.result).toMatchObject({ type: "task.edit", task: { title: "Renamed", revision: 2 } })
  })

  test("a refused child create leaves neither the child nor a parent bump behind", async () => {
    const root = await commands.execute(ACTOR, { clientRequestId: "request-root", command: createTask })
    const rootId = root.result.type === "task.create" ? root.result.task.id : ""

    const detail = await refusalOf(() =>
      commands.execute(ACTOR, {
        clientRequestId: "request-child",
        command: {
          type: "task.create",
          input: { projectId: PROJECT, title: "Child", description: "", workspaceId: "elsewhere", parentTaskId: rootId },
        },
      }),
    )
    expect(detail.code).toBe("invalid_input")
    expect((await store.tasks.get(ACTOR.scopeId, rootId))?.childSetRevision).toBe(0)
    expect(
      await store.tasks.countChildren(ACTOR.scopeId, rootId, { includeArchived: true, excludeStatus: null }),
    ).toBe(0)
    expect(await store.receipts.get(ACTOR.scopeId, "request-child")).toBeUndefined()
  })

  test("receipts are scoped, so another scope's request id is free", async () => {
    await commands.execute(ACTOR, { clientRequestId: "request-once", command: createTask })
    const other = await commands.execute({ scopeId: "scope-beta", ownerId: "owner-alpha" }, {
      clientRequestId: "request-once",
      command: createTask,
    })
    expect(other.replayed).toBe(false)
  })
})
