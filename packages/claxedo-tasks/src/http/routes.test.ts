import { beforeEach, describe, expect, test } from "bun:test"
import type { Hono } from "hono"
import { encodeAttachmentData } from "../attachments"
import { TASKS_BOUNDS, TASKS_PROTOCOL_VERSION, type Preset, type Task } from "../contracts"
import { createTasksCommands } from "../commands"
import { createMemoryTasksStore } from "../stores/memory"
import {
  ACTOR,
  type FakeAuthorization,
  type FakeBridge,
  fakeAuthorization,
  fakeBridge,
  fakeCapabilities,
  fakeClock,
  fakeIds,
} from "../test-support/fakes"
import { presetDraft } from "../test-support/rows"
import type { TasksStorePort } from "../ports/store"
import { createTasksRoutes, type TasksAuthenticate } from "./routes"

const PROJECT = "project-alpha"

type Seeded = { preset: Preset; task: Task }

describe("tasks routes", () => {
  let store: TasksStorePort
  let authorization: FakeAuthorization
  let bridge: FakeBridge
  let app: Hono
  let authenticate: TasksAuthenticate

  const build = () =>
    createTasksRoutes({
      store,
      authorization,
      authenticate: (request) => authenticate(request),
      bridge,
      capabilities: fakeCapabilities(),
      clock: fakeClock(),
      ids: fakeIds(),
    })

  const seed = async (): Promise<Seeded> => {
    const commands = createTasksCommands({
      store,
      clock: fakeClock(5_000),
      ids: fakeIds(),
      capabilities: fakeCapabilities(),
      authorization,
      bridge,
    })
    const preset = await commands.execute(ACTOR, {
      clientRequestId: "seed-preset",
      command: { type: "preset.create", input: presetDraft() },
    })
    const task = await commands.execute(ACTOR, {
      clientRequestId: "seed-task",
      command: {
        type: "task.create",
        input: {
          projectId: PROJECT,
          title: "Ship the thing",
          description: "Details",
          workspaceId: null,
          parentTaskId: null,
        },
      },
    })
    if (preset.result.type !== "preset.create" || task.result.type !== "task.create") throw new Error("seed failed")
    return { preset: preset.result.preset, task: task.result.task }
  }

  const json = async (response: Response): Promise<Record<string, unknown>> => {
    const body: unknown = await response.json()
    return body && typeof body === "object" && !Array.isArray(body) ? { ...body } : {}
  }

  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } })

  beforeEach(() => {
    store = createMemoryTasksStore()
    authorization = fakeAuthorization()
    bridge = fakeBridge()
    authenticate = () => ({ actor: ACTOR })
    app = build()
  })

  test("an unauthenticated caller gets 401 on every route", async () => {
    authenticate = () => ({ error: "No credential", status: 401 })
    for (const path of ["/capabilities", "/presets", "/tasks?projectId=project-alpha", "/tasks/task-1"]) {
      expect((await app.request(path)).status).toBe(401)
    }
    expect((await post("/commands", {})).status).toBe(401)
  })

  test("a host that answers 403 keeps the 403", async () => {
    authenticate = () => ({ error: "Wrong workspace", status: 403 })
    expect((await app.request("/presets")).status).toBe(403)
  })

  test("capabilities report the protocol version, the host's placements and the bounds", async () => {
    const response = await app.request("/capabilities")
    expect(response.status).toBe(200)
    expect(await json(response)).toMatchObject({
      protocolVersion: TASKS_PROTOCOL_VERSION,
      placements: ["local", "cloud"],
      cloudSelectedCapabilities: true,
      configurationSlots: ["primary", "planning", "implementation", "review"],
      bounds: { taskTitleMax: TASKS_BOUNDS.taskTitleMax },
    })
  })

  test("preset reads answer the catalog and 404 an id that is not the caller's", async () => {
    const { preset } = await seed()
    expect(await json(await app.request(`/presets/${preset.id}`))).toMatchObject({ preset: { id: preset.id } })
    expect((await app.request("/presets/preset-missing")).status).toBe(404)

    const list = await json(await app.request("/presets"))
    expect(list).toMatchObject({ nextCursor: null })
    expect(Array.isArray(list.items) && list.items).toHaveLength(1)
  })

  test("a query the package cannot read is a 400 naming the field", async () => {
    expect((await app.request("/presets?limit=abc")).status).toBe(400)
    expect((await app.request("/presets?limit=1000")).status).toBe(400)
    expect((await app.request("/presets?includeArchived=maybe")).status).toBe(400)
    const detail = await json(await app.request("/tasks"))
    expect(detail).toMatchObject({
      error: { code: "invalid_input", fields: [{ path: "projectId", reason: "required" }] },
    })
    expect((await app.request("/tasks")).status).toBe(400)
  })

  test("task reads answer detail, children and a filtered list", async () => {
    const { task } = await seed()
    expect(await json(await app.request(`/tasks?projectId=${PROJECT}`))).toMatchObject({
      items: [{ id: task.id, hasDescription: true }],
    })
    expect(await json(await app.request(`/tasks/${task.id}`))).toMatchObject({ task: { id: task.id }, links: [] })
    expect(await json(await app.request(`/tasks/${task.id}/children`))).toMatchObject({ items: [], nextCursor: null })
  })

  test("an image attached at create is listed by detail and served by its own route with its type and name", async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
    const created = await post("/commands", {
      clientRequestId: "with-image",
      command: {
        type: "task.create",
        input: {
          projectId: PROJECT,
          title: "Match the mock",
          description: "",
          workspaceId: null,
          parentTaskId: null,
          attachments: [{ filename: "mock ü.png", mime: "image/png", data: encodeAttachmentData(bytes) }],
        },
      },
    })
    expect(created.status).toBe(200)
    const result = (await json(created)).result as { task: Task }
    const detail = await json(await app.request(`/tasks/${result.task.id}`))
    expect(detail).toMatchObject({
      attachments: [{ id: "attachment-1", filename: "mock ü.png", mime: "image/png", size: 4 }],
    })

    const served = await app.request(`/tasks/${result.task.id}/attachments/attachment-1`)
    expect(served.status).toBe(200)
    expect(served.headers.get("content-type")).toBe("image/png")
    expect(served.headers.get("content-length")).toBe("4")
    expect(served.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''mock%20%C3%BC.png")
    expect(served.headers.get("cache-control")).toBe("private, max-age=31536000, immutable")
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes)

    expect((await app.request(`/tasks/${result.task.id}/attachments/attachment-2`)).status).toBe(404)
    authorization.denyProject(PROJECT)
    expect((await app.request(`/tasks/${result.task.id}/attachments/attachment-1`)).status).toBe(403)
  })

  test("a create whose image is refused names the image and leaves no task", async () => {
    const refused = await post("/commands", {
      clientRequestId: "bad-image",
      command: {
        type: "task.create",
        input: {
          projectId: PROJECT,
          title: "Match the mock",
          description: "",
          workspaceId: null,
          parentTaskId: null,
          attachments: [{ filename: "mock.svg", mime: "image/svg+xml", data: "PHN2Zz4=" }],
        },
      },
    })
    expect(refused.status).toBe(400)
    expect(await json(refused)).toMatchObject({
      error: { code: "invalid_input", fields: [{ path: "attachments[0].mime", reason: "unknown_value" }] },
    })
    expect(await json(await app.request(`/tasks?projectId=${PROJECT}`))).toMatchObject({ items: [] })
  })

  test("a project the actor cannot read is 403 and a task that is not there is 404", async () => {
    const { task } = await seed()
    authorization.denyProject(PROJECT)
    expect((await app.request(`/tasks/${task.id}`)).status).toBe(403)
    expect((await app.request(`/tasks?projectId=${PROJECT}`)).status).toBe(403)
    expect((await app.request("/tasks/task-missing")).status).toBe(404)
  })

  test("a command commits and a stale revision is 409 with the current record", async () => {
    const { task } = await seed()
    const edited = await post("/commands", {
      clientRequestId: "request-edit",
      command: {
        type: "task.edit",
        input: { taskId: task.id, revision: 1, title: "Renamed", description: "", workspaceId: null },
      },
    })
    expect(edited.status).toBe(200)
    expect(await json(edited)).toMatchObject({ replayed: false, result: { type: "task.edit", task: { revision: 2 } } })

    const stale = await post("/commands", {
      clientRequestId: "request-edit-again",
      command: {
        type: "task.edit",
        input: { taskId: task.id, revision: 1, title: "Later", description: "", workspaceId: null },
      },
    })
    expect(stale.status).toBe(409)
    expect(await json(stale)).toMatchObject({ error: { code: "stale_revision", currentTask: { revision: 2 } } })
  })

  test("an unknown command, a malformed input and a non-JSON body are all 400", async () => {
    expect(
      (await post("/commands", { clientRequestId: "r", command: { type: "task.delete", input: {} } })).status,
    ).toBe(400)
    expect(
      (await post("/commands", { clientRequestId: "r", command: { type: "task.create", input: { projectId: 7 } } }))
        .status,
    ).toBe(400)
    expect(
      (
        await app.request("/commands", {
          method: "POST",
          body: "not json",
          headers: { "Content-Type": "application/json" },
        })
      ).status,
    ).toBe(400)
  })

  test("a body over the cap is refused before it is parsed", async () => {
    const oversized = JSON.stringify({
      clientRequestId: "request-big",
      command: {
        type: "task.create",
        input: {
          projectId: PROJECT,
          title: "x".repeat(TASKS_BOUNDS.commandRequestMaxBytes),
          description: "",
          workspaceId: null,
          parentTaskId: null,
        },
      },
    })
    const response = await app.request("/commands", {
      method: "POST",
      body: oversized,
      headers: { "Content-Type": "application/json" },
    })
    expect(response.status).toBe(413)
    expect(
      (
        await store.tasks.list(ACTOR.scopeId, {
          projectId: PROJECT,
          status: null,
          parent: "any",
          cursor: null,
          limit: 50,
          includeArchived: false,
        })
      ).items,
    ).toHaveLength(0)
  })

  test("small bodies with excessive elements or invalid fields return bounded errors", async () => {
    for (const [count, expectedFields] of [
      [1_000, 1],
      [TASKS_BOUNDS.pluginReferencesMax, 64],
    ] as const) {
      const body = {
        clientRequestId: `invalid-plugins-${count}`,
        command: {
          type: "preset.create",
          input: {
            ...presetDraft(),
            execution: {
              placement: "cloud",
              capabilities: { mode: "selected", plugins: Array.from({ length: count }, () => ({})), skills: [] },
            },
          },
        },
      }
      expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeLessThan(
        TASKS_BOUNDS.commandRequestMaxBytes,
      )
      const response = await post("/commands", body)
      expect(response.status).toBe(400)
      const result = await response.json()
      expect(result.error.code).toBe("invalid_input")
      expect(result.error.fields).toHaveLength(expectedFields)
      if (count > TASKS_BOUNDS.pluginReferencesMax) {
        expect(result.error.fields).toEqual([
          { path: "command.input.execution.capabilities.plugins", reason: "too_many" },
        ])
      }
    }
    expect(await json(await app.request("/presets"))).toMatchObject({ items: [] })
    expect(bridge.starts).toHaveLength(0)
  })

  test("a declared content-length over the cap is refused without reading the body", async () => {
    const response = await app.request("/tasks/task-1/start-preview", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json", "Content-Length": String(TASKS_BOUNDS.startRequestMaxBytes + 1) },
    })
    expect(response.status).toBe(413)
  })

  // No Content-Length means no precheck — the stream itself must stop at the
  // cap, and a chunked producer that never ends must not be drained whole.
  test("a chunked body with no declared length is refused mid-stream at the cap", async () => {
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(TASKS_BOUNDS.startRequestMaxBytes))
      },
    })
    const response = await app.request("/tasks/task-1/start-preview", {
      method: "POST",
      // @ts-expect-error — duplex is required for a streaming body
      duplex: "half",
      body: stream,
      headers: { "Content-Type": "application/json" },
    })
    expect(response.status).toBe(413)
    expect(pulls).toBeLessThan(10)
  })

  test("preview and start run through the bridge and report the link", async () => {
    const { preset, task } = await seed()
    const preview = await post(`/tasks/${task.id}/start-preview`, {
      taskRevision: task.revision,
      presetId: preset.id,
      presetRevision: preset.revision,
      slot: "primary",
      attempt: 1,
      continueFromPrevious: false,
    })
    expect(preview.status).toBe(200)
    expect(await json(preview)).toMatchObject({ preview: { placement: "local", attempt: 1, available: true } })

    const started = await post(`/tasks/${task.id}/sessions`, {
      clientRequestId: "request-start",
      taskRevision: task.revision,
      presetId: preset.id,
      presetRevision: preset.revision,
      slot: "primary",
      attempt: 1,
      previewDigest: "digest-1",
      handoffText: null,
      continueFromPrevious: false,
    })
    expect(started.status).toBe(200)
    expect(await json(started)).toMatchObject({ created: true, link: { attempt: 1, liveness: "live" } })
    expect(await json(await app.request(`/tasks/${task.id}`))).toMatchObject({
      links: [{ sessionRef: { sessionId: "session-1" } }],
    })
  })

  test("a start naming an attempt the slot cannot accept is 409", async () => {
    const { preset, task } = await seed()
    const body = {
      clientRequestId: "request-start",
      taskRevision: task.revision,
      presetId: preset.id,
      presetRevision: preset.revision,
      slot: "primary",
      attempt: 2,
      previewDigest: "digest-1",
      handoffText: null,
      continueFromPrevious: false,
    }
    const response = await post(`/tasks/${task.id}/sessions`, body)
    expect(response.status).toBe(409)
    expect(await json(response)).toMatchObject({ error: { code: "conflict" } })
  })

  test("a start body missing its digest is 400, and the bridge is never called", async () => {
    const { preset, task } = await seed()
    const response = await post(`/tasks/${task.id}/sessions`, {
      clientRequestId: "request-start",
      taskRevision: task.revision,
      presetId: preset.id,
      presetRevision: preset.revision,
      slot: "primary",
      attempt: 1,
      handoffText: null,
      continueFromPrevious: false,
    })
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ error: { fields: [{ path: "previewDigest", reason: "required" }] } })
    expect(bridge.starts).toHaveLength(0)
  })

  test("a cloud preset on a local-only host is 422", async () => {
    app = createTasksRoutes({
      store,
      authorization,
      authenticate: (request) => authenticate(request),
      bridge,
      capabilities: fakeCapabilities({ placements: ["local"] }),
      clock: fakeClock(),
      ids: fakeIds(),
    })
    const response = await post("/commands", {
      clientRequestId: "request-cloud",
      command: {
        type: "preset.create",
        input: presetDraft({
          execution: { placement: "cloud", capabilities: { mode: "selected", plugins: [], skills: [] } },
        }),
      },
    })
    expect(response.status).toBe(422)
    expect(await json(response)).toMatchObject({ error: { code: "unsupported" } })
  })
})
