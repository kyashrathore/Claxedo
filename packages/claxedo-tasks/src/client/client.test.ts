import { beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { TASKS_PROTOCOL_VERSION, TASKS_ROUTE_PATH, type Preset, type Task } from "../contracts"
import { createTasksRoutes } from "../http/routes"
import { createMemoryTasksStore } from "../stores/memory"
import {
  ACTOR,
  fakeAuthorization,
  fakeBridge,
  fakeCapabilities,
  fakeClock,
  fakeIds,
  presetDraft,
  type FakeAuthorization,
} from "../test-support/harness"
import type { TasksStorePort } from "../ports/store"
import { TasksApiError, TasksClientPayloadError, createTasksClient, type TasksClient } from "./client"

const ORIGIN = "http://tasks.test"
const PROJECT = "project-alpha"

describe("tasks client over the real routes", () => {
  let store: TasksStorePort
  let authorization: FakeAuthorization
  let client: TasksClient

  beforeEach(() => {
    store = createMemoryTasksStore()
    authorization = fakeAuthorization()
    const host = new Hono()
    host.route(
      TASKS_ROUTE_PATH,
      createTasksRoutes({
        store,
        authorization,
        authenticate: () => ({ actor: ACTOR }),
        bridge: fakeBridge(),
        capabilities: fakeCapabilities(),
        clock: fakeClock(),
        ids: fakeIds(),
      }),
    )
    client = createTasksClient({
      baseUrl: `${ORIGIN}${TASKS_ROUTE_PATH}`,
      request: async (input, init) => host.request(input, init),
    })
  })

  const createPreset = async (): Promise<Preset> => {
    const response = await client.command({
      clientRequestId: "request-preset",
      command: { type: "preset.create", input: presetDraft({ name: "Careful" }) },
    })
    if (response.result.type !== "preset.create") throw new Error("unexpected result")
    return response.result.preset
  }

  const createTask = async (title = "Ship the thing"): Promise<Task> => {
    const response = await client.command({
      clientRequestId: `request-task-${title}`,
      command: {
        type: "task.create",
        input: { projectId: PROJECT, title, description: "Details", workspaceId: null, parentTaskId: null },
      },
    })
    if (response.result.type !== "task.create") throw new Error("unexpected result")
    return response.result.task
  }

  test("reads capabilities", async () => {
    const capabilities = await client.capabilities()
    expect(capabilities.protocolVersion).toBe(TASKS_PROTOCOL_VERSION)
    expect(capabilities.placements).toEqual(["local", "cloud"])
    expect(capabilities.bounds.listLimitMax).toBe(100)
  })

  test("round-trips a preset through the command route and both reads", async () => {
    const preset = await createPreset()
    expect(await client.getPreset(preset.id)).toEqual(preset)
    expect((await client.listPresets()).items.map((row) => row.id)).toEqual([preset.id])
    expect((await client.listPresets({ includeArchived: true, limit: 1 })).items).toHaveLength(1)
  })

  test("round-trips a task, its children and its detail", async () => {
    const task = await createTask()
    const child = await client.command({
      clientRequestId: "request-child",
      command: {
        type: "task.create",
        input: { projectId: PROJECT, title: "Child", description: "", workspaceId: null, parentTaskId: task.id },
      },
    })
    expect(child.result.type).toBe("task.create")

    const detail = await client.getTask(task.id)
    expect(detail.task.id).toBe(task.id)
    expect(detail.links).toEqual([])

    const list = await client.listTasks({ projectId: PROJECT, parent: "root" })
    expect(list.items.map((row) => row.title)).toEqual(["Ship the thing"])

    const children = await client.listChildren(task.id)
    expect(children.items.map((row) => row.title)).toEqual(["Child"])
  })

  test("pages with the cursor the server returned", async () => {
    await createTask("First")
    await createTask("Second")
    await createTask("Third")

    const first = await client.listTasks({ projectId: PROJECT, limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()

    const second = await client.listTasks({ projectId: PROJECT, limit: 2, cursor: first.nextCursor })
    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    const titles = [...first.items, ...second.items].map((row) => row.title)
    expect(new Set(titles).size).toBe(3)
  })

  test("previews and starts a session", async () => {
    const preset = await createPreset()
    const task = await createTask()
    const { preview } = await client.startPreview(task.id, {
      taskRevision: task.revision,
      presetId: preset.id,
      presetRevision: preset.revision,
      slot: "primary",
      attempt: 1,
      continueFromPrevious: false,
    })
    expect(preview.available).toBe(true)

    const started = await client.start(task.id, {
      clientRequestId: "request-start",
      taskRevision: task.revision,
      presetId: preset.id,
      presetRevision: preset.revision,
      slot: "primary",
      attempt: 1,
      previewDigest: preview.digest,
      handoffText: "Continue the spike",
      continueFromPrevious: false,
    })
    expect(started.created).toBe(true)
    expect(started.link.presetNameAtStart).toBe("Careful")
    expect((await client.getTask(task.id)).links[0]?.liveness).toBe("live")
  })

  test("a refusal arrives as a typed error carrying the server's code and fields", async () => {
    const missing = await client.getPreset("preset-missing").catch((cause: unknown) => cause)
    expect(missing).toBeInstanceOf(TasksApiError)
    expect(missing instanceof TasksApiError && missing.code).toBe("not_found")
    expect(missing instanceof TasksApiError && missing.status).toBe(404)

    const invalid = await client
      .command({
        clientRequestId: "request-bad",
        command: { type: "preset.create", input: presetDraft({ name: "" }) },
      })
      .catch((cause: unknown) => cause)
    expect(invalid).toBeInstanceOf(TasksApiError)
    expect(invalid instanceof TasksApiError && invalid.code).toBe("invalid_input")
    expect(invalid instanceof TasksApiError && invalid.detail.fields).toEqual([{ path: "name", reason: "required" }])
  })

  test("a body that is not a tasks response is a payload error, not a typed record", async () => {
    const impostor = new Hono()
    impostor.get("/presets/:id", (c) => c.json({ preset: { id: "preset-1" } }))
    impostor.get("/capabilities", (c) => c.text("not json"))
    const rogue = createTasksClient({ baseUrl: `${ORIGIN}/rogue`, request: async (input, init) => impostor.request(input.replace("/rogue", ""), init) })

    const truncated = await rogue.getPreset("preset-1").catch((cause: unknown) => cause)
    expect(truncated).toBeInstanceOf(TasksClientPayloadError)
    expect(truncated instanceof TasksClientPayloadError && truncated.fields.map((field) => field.path)).toContain("preset.scopeId")

    const unparseable = await rogue.capabilities().catch((cause: unknown) => cause)
    expect(unparseable).toBeInstanceOf(TasksClientPayloadError)
  })

  test("a lost authority surfaces as forbidden, not as an empty list", async () => {
    await createTask()
    authorization.denyProject(PROJECT)
    const denied = await client.listTasks({ projectId: PROJECT }).catch((cause: unknown) => cause)
    expect(denied).toBeInstanceOf(TasksApiError)
    expect(denied instanceof TasksApiError && denied.code).toBe("forbidden")
  })
})
