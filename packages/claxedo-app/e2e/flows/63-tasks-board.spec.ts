import type { Locator, Page } from "@playwright/test"
import { pluginSurface, tasksClient } from "../harness/tasks"
import { expect, test, UI } from "../harness"

const SWATCH = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGNQTX5NEmIY1TCqYfhqAAB2SXMQ7mVTQgAAAABJRU5ErkJggg=="

async function seedPreset(serverUrl: string) {
  const configuration = { harness: { id: "pi", access: "native" as const }, model: { providerID: "pi", modelID: "openai/gpt-4.1" }, effort: null }
  await tasksClient(serverUrl).command({
    clientRequestId: crypto.randomUUID(),
    command: { type: "preset.create", input: { name: "Pi locally", instructions: "", execution: { placement: "local", capabilities: { mode: "inherit-local" } }, configurations: { primary: configuration }, agentStartable: false } },
  })
}

async function openTasks(app: Page, isMobile: boolean) {
  const row = app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: "Tasks", exact: true })
  if (isMobile) {
    const open = app.getByRole("button", { name: UI.openRail })
    await expect(async () => {
      if (await open.isVisible()) await open.tap()
      await expect(row).toBeInViewport({ ratio: 1, timeout: 1000 })
    }).toPass()
  }
  await row.click()
  await expect(app).toHaveURL(/\/tasks$/)
}

async function pasteImage(field: Locator, name: string) {
  await field.evaluate((element, input) => {
    const bytes = Uint8Array.from(atob(input.data), (character) => character.charCodeAt(0))
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], input.name, { type: "image/png" }))
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }))
  }, { data: SWATCH, name })
}

async function createWithImages(app: Page, surface: Locator) {
  await surface.getByRole("button", { name: "New task", exact: true }).click()
  const form = surface.getByRole("region", { name: "New task" })
  await form.getByRole("textbox", { name: "Title" }).fill("Ship the board")
  await form.getByRole("group", { name: "Images" }).locator('input[type="file"]').setInputFiles({ name: "picked.png", mimeType: "image/png", buffer: Buffer.from(SWATCH, "base64") })
  await pasteImage(form.getByRole("textbox", { name: "Description" }), "pasted.png")
  await expect(form.getByRole("img", { name: "picked.png" })).toBeVisible()
  await expect(form.getByRole("img", { name: "pasted.png" })).toBeVisible()
  await form.getByRole("button", { name: "Create task", exact: true }).click()
  await expect(app).toHaveURL(/\/tasks\/tsk_[^/]+$/)
  return decodeURIComponent(app.url().split("/tasks/")[1] ?? "")
}

async function moveOnTheBoard(app: Page, surface: Locator, serverUrl: string, taskId: string, isMobile: boolean) {
  await surface.getByRole("button", { name: "All tasks", exact: true }).first().click()
  await expect(app).toHaveURL(/\/tasks$/)
  await surface.getByRole("button", { name: "Board", exact: true }).click()
  const todo = surface.getByRole("region", { name: "To do" })
  const doing = surface.getByRole("region", { name: "In progress" })
  const card = (lane: Locator) => lane.locator('[data-slot="surface-board-item"]').filter({ hasText: "Ship the board" })
  if (!isMobile) {
    await card(todo).dragTo(doing.locator('[data-slot="surface-board-items"]'))
    await expect(card(doing)).toBeVisible()
    await expect.poll(async () => (await tasksClient(serverUrl).getTask(taskId)).task.status).toBe("doing")
  } else {
    await card(todo).getByRole("button", { name: "Move Ship the board to In progress" }).click()
    await expect(card(doing)).toBeVisible()
  }
  await card(doing).focus()
  await app.keyboard.press(" ")
  await app.keyboard.press("ArrowRight")
  await app.keyboard.press(" ")
  await expect(card(surface.getByRole("region", { name: "Needs you" }))).toBeVisible()
  await expect.poll(async () => (await tasksClient(serverUrl).getTask(taskId)).task.status).toBe("needs_you")
}

async function editAndConflict(app: Page, surface: Locator, serverUrl: string, taskId: string) {
  await surface.locator('[data-slot="surface-board-item"]').filter({ hasText: "Ship the board" }).getByRole("button", { name: "Open", exact: true }).click()
  await expect(app).toHaveURL(new RegExp(`/tasks/${taskId}$`))
  const details = surface.getByRole("region", { name: "Details" })
  await details.getByRole("textbox", { name: "Title" }).fill("Ship the board today")
  await details.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(surface.getByRole("heading", { name: "Ship the board today" })).toBeVisible()
  const current = (await tasksClient(serverUrl).getTask(taskId)).task
  await tasksClient(serverUrl).command({ clientRequestId: crypto.randomUUID(), command: { type: "task.edit", input: { taskId, revision: current.revision, title: "Renamed elsewhere", description: current.description, workspaceId: current.workspaceId } } })
  await details.getByRole("textbox", { name: "Description" }).fill("Mine")
  await details.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(surface.getByText("This task changed elsewhere", { exact: true })).toBeVisible()
  await expect(details.getByRole("textbox", { name: "Description" })).toHaveValue("Mine")
  await details.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect.poll(async () => (await tasksClient(serverUrl).getTask(taskId)).task.description).toBe("Mine")
}

async function addSubtask(surface: Locator, serverUrl: string, taskId: string) {
  const subtasks = surface.getByRole("region", { name: "Subtasks" })
  await subtasks.getByRole("textbox", { name: "New subtask" }).fill("Write the release note")
  await subtasks.getByRole("button", { name: "Add subtask", exact: true }).click()
  await expect(subtasks.getByText("Write the release note", { exact: true })).toBeVisible()
  await expect(subtasks.getByRole("textbox", { name: "New subtask" })).toHaveValue("")
  expect((await tasksClient(serverUrl).listChildren(taskId)).items.map((child) => child.title)).toEqual(["Write the release note"])
}

test("63 Tasks: create with a picked and a pasted image, move on the board by drag and keyboard, edit through a conflict, add a subtask and Start a local preset", async ({ stack, app, isMobile }) => {
  await stack.daemon.makeWorkspace("tasks", "Tasks project")
  await seedPreset(stack.url)
  await app.goto(stack.url)
  await expect(app).toHaveURL(/\/w\/[^/]+\/session$/)
  await openTasks(app, isMobile)
  const surface = pluginSurface(app)
  await expect(surface.locator('[data-slot="surface-source"]')).toHaveText("Tasks · app plugin")

  const taskId = await createWithImages(app, surface)
  await expect(surface.getByRole("region", { name: "Images" }).getByRole("img")).toHaveCount(2)
  expect((await tasksClient(stack.url).getTask(taskId)).attachments.map((attachment) => attachment.filename).sort()).toEqual(["pasted.png", "picked.png"])

  await moveOnTheBoard(app, surface, stack.url, taskId, isMobile)
  await editAndConflict(app, surface, stack.url, taskId)
  await addSubtask(surface, stack.url, taskId)

  const sessions = surface.getByRole("region", { name: "Sessions" })
  await sessions.getByRole("button", { name: "Start", exact: true }).click()
  await expect(app).toHaveURL(/\/session\/[^/]+$/, { timeout: 30_000 })
  await expect.poll(async () => (await tasksClient(stack.url).getTask(taskId)).links.map((link) => link.presetNameAtStart)).toEqual(["Pi locally"])
})
