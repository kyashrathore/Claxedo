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
  const newTask = surface.getByRole("button", { name: "New task", exact: true })
  await newTask.click()
  const dialog = app.getByRole("dialog", { name: "New task" })
  await dialog.getByRole("textbox", { name: "Task title" }).fill("Thrown away")
  await app.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(newTask).toBeFocused()
  await newTask.click()
  await expect(dialog.getByRole("textbox", { name: "Task title" })).toHaveValue("")
  await dialog.getByRole("group", { name: "Attach images, up to 6" }).locator('input[type="file"]').setInputFiles({ name: "picked.png", mimeType: "image/png", buffer: Buffer.from(SWATCH, "base64") })
  await pasteImage(dialog.getByRole("textbox", { name: "Description" }), "pasted.png")
  await expect(dialog.getByRole("img", { name: "picked.png" })).toBeVisible()
  await expect(dialog.getByRole("img", { name: "pasted.png" })).toBeVisible()
  await dialog.getByRole("textbox", { name: "Task title" }).fill("Ship the board")
  await app.keyboard.press("Enter")
  await expect(app).toHaveURL(/\/tasks\/tsk_[^/]+$/)
  return decodeURIComponent(app.url().split("/tasks/")[1] ?? "")
}

function card(lane: Locator) {
  return lane.locator('[data-slot="surface-board-item"]').filter({ hasText: "Ship the board" })
}

async function moveOnTheBoard(app: Page, surface: Locator, serverUrl: string, taskId: string, isMobile: boolean) {
  await surface.getByRole("button", { name: "Tasks", exact: true }).first().click()
  await expect(app).toHaveURL(/\/tasks$/)
  await surface.getByRole("button", { name: "Board", exact: true }).click()
  const todo = surface.getByRole("region", { name: "To do" })
  const doing = surface.getByRole("region", { name: "In progress" })
  if (!isMobile) {
    await card(todo).dragTo(doing.locator('[data-slot="surface-board-items"]'))
    await expect(card(doing)).toBeVisible()
    await expect.poll(async () => (await tasksClient(serverUrl).getTask(taskId)).task.status).toBe("doing")
  } else {
    await card(todo).getByRole("button", { name: "Status: To do" }).click()
    await app.getByRole("menuitemradio", { name: "In progress", exact: true }).click()
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
  await card(surface.getByRole("region", { name: "Needs you" })).getByRole("button", { name: "Ship the board", exact: true }).click()
  await expect(app).toHaveURL(new RegExp(`/tasks/${taskId}$`))
  const save = surface.getByRole("button", { name: "Save changes", exact: true })
  await expect(surface.getByRole("textbox", { name: "Task title" })).toHaveValue("Ship the board")
  await expect(save).toHaveCount(0)
  await surface.getByRole("textbox", { name: "Task title" }).fill("Ship the board today")
  await save.click()
  await expect(save).toHaveCount(0)
  await expect.poll(async () => (await tasksClient(serverUrl).getTask(taskId)).task.title).toBe("Ship the board today")
  const current = (await tasksClient(serverUrl).getTask(taskId)).task
  await tasksClient(serverUrl).command({ clientRequestId: crypto.randomUUID(), command: { type: "task.edit", input: { taskId, revision: current.revision, title: "Renamed elsewhere", description: current.description, workspaceId: current.workspaceId } } })
  const description = surface.getByRole("textbox", { name: "Description" })
  await description.fill("Mine")
  await save.click()
  await expect(surface.getByText("This task changed elsewhere", { exact: true })).toBeVisible()
  await expect(description).toHaveText("Mine")
  await save.click()
  await expect.poll(async () => (await tasksClient(serverUrl).getTask(taskId)).task.description).toBe("Mine")
}

async function addSubtask(app: Page, surface: Locator, serverUrl: string, taskId: string) {
  const subtasks = surface.getByRole("region", { name: "Subtasks" })
  await subtasks.getByRole("textbox", { name: "New subtask" }).fill("Write the release note")
  await app.keyboard.press("Enter")
  await expect(subtasks.getByRole("button", { name: "Write the release note", exact: true })).toBeVisible()
  await expect(subtasks.getByRole("textbox", { name: "New subtask" })).toHaveValue("")
  expect((await tasksClient(serverUrl).listChildren(taskId)).items.map((child) => child.title)).toEqual(["Write the release note"])
}

test("63 Tasks: a New task dialog that Escape closes, create with a picked and a pasted image, move on the board by drag, status chip and keyboard, open a card, edit through a conflict, add a subtask and Start a local preset", async ({ stack, app, isMobile }) => {
  await stack.daemon.makeWorkspace("tasks", "Tasks project")
  await seedPreset(stack.url)
  await app.goto(stack.url)
  await expect(app).toHaveURL(/\/w\/[^/]+\/session$/)
  await openTasks(app, isMobile)
  const surface = pluginSurface(app)
  await expect(surface.locator('[data-slot="surface-source"]')).toHaveText("Tasks · app plugin")

  const taskId = await createWithImages(app, surface)
  await expect(surface.getByRole("region", { name: "Images" }).getByRole("img")).toHaveCount(2)
  await expect(surface.getByText("Tasks project › TP-1", { exact: true })).toBeVisible()
  expect((await tasksClient(stack.url).getTask(taskId)).attachments.map((attachment) => attachment.filename).sort()).toEqual(["pasted.png", "picked.png"])

  await moveOnTheBoard(app, surface, stack.url, taskId, isMobile)
  await editAndConflict(app, surface, stack.url, taskId)
  await addSubtask(app, surface, stack.url, taskId)

  const sessions = surface.getByRole("region", { name: "Sessions" })
  await sessions.getByRole("button", { name: "Start", exact: true }).click()
  await expect(app).toHaveURL(/\/session\/[^/]+$/, { timeout: 30_000 })
  await expect.poll(async () => (await tasksClient(stack.url).getTask(taskId)).links.map((link) => link.presetNameAtStart)).toEqual(["Pi locally"])
})
