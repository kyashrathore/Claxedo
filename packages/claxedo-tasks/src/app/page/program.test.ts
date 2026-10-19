import { describe, expect, test } from "bun:test"
import type { ProjectSummary, SessionRef, Toast, WorkspaceStartResult } from "@claxedo/plugin-api"
import type { Preset } from "../../contracts"
import { presetDraft } from "../../test-support/rows"
import type { Json } from "../surface/json"
import { actionsSettled, englishWords, reachableIds, recordedSurface, surfaceAction, tasksServer } from "../test-host"
import type { PageDeps } from "./page-model"
import { openTasksPage } from "./program"

const PROJECTS: ProjectSummary[] = [{ id: "project-alpha", name: "Claxedo app" }]
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

function openPage(params: Record<string, string> = {}, options: { followStart?: PageDeps["followStart"] } = {}) {
  const server = tasksServer()
  const surface = recordedSurface()
  const pages: (Readonly<Record<string, string>> | undefined)[] = []
  const sessions: SessionRef[] = []
  const toasts: Toast[] = []
  let ids = 0
  const deps: PageDeps = {
    client: server.client,
    t: englishWords,
    ui: { toast: (toast) => void toasts.push(toast), confirm: async () => true },
    openPage: (next) => void pages.push(next),
    openPresets: () => undefined,
    openSession: async (session) => void sessions.push(session),
    followStart: options.followStart ?? (async (): Promise<WorkspaceStartResult> => ({ kind: "running" })),
    projects: () => PROJECTS,
    currentProjectId: () => undefined,
    watchProjects: () => undefined,
    requestId: () => `request-${(ids += 1)}`,
    now: () => 10_000,
  }
  const program = openTasksPage(deps, surface, { path: "/tasks/:taskId?", params })
  const fire = async (name: string, context: Record<string, Json | undefined> = {}, source = "test") => {
    await program.action?.(surfaceAction(name, context, source))
    await actionsSettled()
  }
  const navigate = async (next: Record<string, string>) => {
    program.navigated?.({ path: "/tasks/:taskId?", params: next })
    await actionsSettled()
  }
  return { server, surface, pages, sessions, toasts, fire, navigate }
}

async function seedTask(server: ReturnType<typeof tasksServer>, title: string, status: "backlog" | "todo" = "todo") {
  const answer = await server.client.command({ clientRequestId: `seed-${title}`, command: { type: "task.create", input: { projectId: "project-alpha", title, description: "", workspaceId: null, parentTaskId: null, status } } })
  if (answer.result.type !== "task.create") throw new Error("seed failed")
  return answer.result.task
}

async function seedPreset(server: ReturnType<typeof tasksServer>): Promise<Preset> {
  const answer = await server.client.command({ clientRequestId: "seed-preset", command: { type: "preset.create", input: presetDraft() } })
  if (answer.result.type !== "preset.create") throw new Error("seed failed")
  return answer.result.preset
}

describe("the Tasks page surface", () => {
  test("lists the project's active tasks grouped by status, valid and reachable", async () => {
    const page = openPage()
    await seedTask(page.server, "Fix the login")
    await page.fire("retryTasks")
    expect(page.surface.check()).toMatchObject({ ok: true })
    expect(page.surface.component("tasks-content")).toMatchObject({ component: "Board", layout: "list", columns: [{ key: "todo", title: "To do" }] })
    expect(page.surface.read("/board/todo")).toMatchObject([{ title: "Fix the login", subtitle: "CA-1 · updated just now", icon: "circle" }])
    expect(page.surface.component("page-header")).toMatchObject({ title: "Tasks", subtitle: "Claxedo app · 1 task", actions: ["page-presets", "page-new"] })
  })

  test("creates a task with a picked image, sends the image, and opens the new task", async () => {
    const page = openPage()
    await actionsSettled()
    await page.fire("openCreateTask")
    expect(page.surface.component("page-header")).toMatchObject({ actions: ["page-presets"] })
    await page.fire("createImagesPicked", { files: [{ name: "shot.png", mimeType: "image/png", size: 70, dataBase64: PIXEL }], refused: [{ name: "notes.txt", reason: "type" }] })
    expect(page.surface.read("/create/images")).toMatchObject([{ name: "shot.png", url: `data:image/png;base64,${PIXEL}` }])
    expect(page.surface.component("create-notice")).toMatchObject({ tone: "warning", text: "notes.txt is not a PNG, JPEG, GIF or WebP image" })
    await page.fire("createTask", { title: "Ship the board", description: "With images", status: ["backlog"], project: "project-alpha" })
    const [task] = (await page.server.client.listTasks({ projectId: "project-alpha", includeArchived: true })).items
    expect(task).toMatchObject({ title: "Ship the board", status: "backlog" })
    expect((await page.server.client.getTask(task?.id ?? "")).attachments).toMatchObject([{ filename: "shot.png", mime: "image/png" }])
    expect(page.pages.at(-1)).toEqual({ taskId: task?.id })
    expect(page.toasts).toEqual([{ kind: "success", title: "Task created" }])
  })

  test("refuses to create without a title and keeps the form", async () => {
    const page = openPage()
    await actionsSettled()
    await page.fire("openCreateTask")
    await page.fire("createTask", { title: " ", description: "", status: ["todo"], project: "project-alpha" })
    expect(page.surface.component("create-notice")).toMatchObject({ tone: "danger", title: "Give the task a title" })
    expect(reachableIds(page.surface).has("create")).toBe(true)
  })

  test("a board move sets the status on the server, and a move within a column is answered with the old list", async () => {
    const page = openPage()
    const task = await seedTask(page.server, "Move me")
    await page.fire("retryTasks")
    page.surface.write("/controls/view", ["board"])
    await page.fire("viewChanged", { value: ["board"] })
    expect(page.surface.component("tasks-content")).toMatchObject({ component: "Board", layout: "columns", columns: [{ key: "todo", headerActions: ["board-add-todo"] }, { key: "doing" }, { key: "needs_you" }] })
    await page.fire("moveTask", { itemId: task.id, fromColumn: "todo", fromIndex: 0, toColumn: "doing", toIndex: 0 })
    expect((await page.server.client.getTask(task.id)).task.status).toBe("doing")
    expect(page.surface.read("/board/doing")).toMatchObject([{ id: task.id }])
    const before = page.surface.messages.length
    await page.fire("moveTask", { itemId: task.id, fromColumn: "doing", fromIndex: 0, toColumn: "doing", toIndex: 0 })
    const patched = page.surface.messages.slice(before).flatMap((message) => ("updateDataModel" in message ? [message.updateDataModel.path] : []))
    expect(patched).toContain("/board/doing")
  })

  test("the detail edits, refuses a stale save with the current title and keeps the edits, and adds a subtask", async () => {
    const page = openPage()
    const task = await seedTask(page.server, "Original")
    await page.navigate({ taskId: task.id })
    expect(page.surface.read("/detail/title")).toBe("Original")
    expect(page.surface.check()).toMatchObject({ ok: true })
    await page.fire("saveTask", { title: "Renamed", description: "Details" })
    expect((await page.server.client.getTask(task.id)).task).toMatchObject({ title: "Renamed", description: "Details" })
    const current = (await page.server.client.getTask(task.id)).task
    await page.server.client.command({ clientRequestId: "elsewhere", command: { type: "task.edit", input: { taskId: task.id, revision: current.revision, title: "Changed elsewhere", description: "", workspaceId: null } } })
    page.surface.write("/detail/title", "Mine")
    await page.fire("saveTask", { title: "Mine", description: "Details" })
    expect(page.surface.component("detail-notice")).toMatchObject({ tone: "warning", title: "This task changed elsewhere" })
    expect(page.surface.read("/detail/title")).toBe("Mine")
    page.surface.write("/detail/newSubtask", "Write the test")
    await page.fire("addSubtask", { value: "Write the test" }, "detail-subtask-new")
    expect(page.surface.read("/detail/subtasks")).toMatchObject([{ title: "Write the test" }])
    expect(page.surface.read("/detail/newSubtask")).toBe("")
  })

  test("Start on a preset opens the session it created", async () => {
    const page = openPage()
    const preset = await seedPreset(page.server)
    const task = await seedTask(page.server, "Start me")
    await page.navigate({ taskId: task.id })
    await page.fire("startSlot", { slot: "primary", preset: [preset.id] })
    expect(page.sessions).toEqual([{ sessionId: "session-1", workspaceId: "workspace-1" }])
    expect(page.server.bridge.starts).toHaveLength(1)
  })

  test("a cloud Start follows the workspace's start, shows its progress, and says why it did not start", async () => {
    const steps: string[] = []
    let finish: (result: WorkspaceStartResult) => void = () => undefined
    const page = openPage({}, {
      followStart: (_, onProgress) => {
        onProgress("Booting the machine")
        return new Promise((resolve) => (finish = resolve))
      },
    })
    const preset = await seedPreset(page.server)
    const task = await seedTask(page.server, "Cloud me")
    page.server.bridge.prepareStart("workspace-cloud")
    await page.navigate({ taskId: task.id })
    await page.fire("startSlot", { slot: "primary", preset: [preset.id] })
    steps.push(String((page.surface.component("slot-primary-progress") as { label?: string } | undefined)?.label))
    finish({ kind: "failed", message: "The machine ran out of credits" })
    await actionsSettled()
    expect(steps).toEqual(["Starting a cloud workspace: Booting the machine"])
    expect(page.surface.component("detail-notice")).toMatchObject({ tone: "warning", title: "Cloud me did not start", text: "The machine ran out of credits" })
    expect(page.sessions).toEqual([])
  })
})
