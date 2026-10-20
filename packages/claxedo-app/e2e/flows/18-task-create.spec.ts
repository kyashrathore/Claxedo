import { pluginSurface, tasksClient } from "../harness/tasks"
import { expect, test } from "../harness"

const SWATCH = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGNQTX5NEmIY1TCqYfhqAAB2SXMQ7mVTQgAAAABJRU5ErkJggg=="

test("18 a task is created from the New task dialog, with a rich description, a status chip and an image kept after another is removed, and read back from the server", async ({ stack, app }) => {
  const workspace = await stack.daemon.makeWorkspace("tasks", "Tasks project")
  await app.goto(`${stack.url}/tasks`)
  const surface = pluginSurface(app)
  const newTask = surface.getByRole("button", { name: "New task", exact: true })
  await newTask.click()

  const dialog = app.getByRole("dialog", { name: "New task" })
  const title = dialog.getByRole("textbox", { name: "Task title", exact: true })
  await expect(title).toBeFocused()
  await expect(title).toHaveAttribute("placeholder", "Task title")
  const parts = [
    dialog.getByText("Tasks project › New task", { exact: true }),
    title,
    dialog.getByRole("textbox", { name: "Description", exact: true }),
    dialog.getByRole("button", { name: "Status: To do", exact: true }),
    dialog.getByRole("button", { name: "Create task", exact: true }),
  ]
  for (const part of parts) await expect(part).toBeVisible()
  const tops = await Promise.all(parts.map(async (part) => (await part.boundingBox())?.y ?? Number.NaN))
  for (const [index, top] of tops.slice(1).entries()) expect(tops[index]).toBeLessThan(top)
  await expect(dialog.getByRole("button", { name: "Project: Tasks project", exact: true })).toBeVisible()

  await dialog.getByRole("group", { name: "Attach images, up to 6" }).locator('input[type="file"]').setInputFiles([
    { name: "keep.png", mimeType: "image/png", buffer: Buffer.from(SWATCH, "base64") },
    { name: "drop.png", mimeType: "image/png", buffer: Buffer.from(SWATCH, "base64") },
  ])
  await expect(dialog.getByRole("img", { name: "drop.png" })).toBeVisible()
  await dialog.getByRole("img", { name: "drop.png" }).hover()
  await dialog.getByRole("button", { name: "Remove drop.png", exact: true }).click()
  await expect(dialog.getByRole("img", { name: "drop.png" })).toHaveCount(0)
  await expect(dialog.getByRole("img", { name: "keep.png" })).toBeVisible()

  await dialog.getByRole("button", { name: "Status: To do", exact: true }).click()
  await app.getByRole("menuitemradio", { name: "Backlog", exact: true }).click()
  await expect(dialog.getByRole("button", { name: "Status: Backlog", exact: true })).toBeVisible()
  await title.fill("Ship the form")
  const description = dialog.getByRole("textbox", { name: "Description", exact: true })
  await description.click()
  await app.keyboard.type("## Plan")
  await app.keyboard.press("Enter")
  await app.keyboard.type("Rich text")
  await expect(description.getByRole("heading", { name: "Plan" })).toBeVisible()
  await dialog.getByRole("button", { name: "Create task", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(app).toHaveURL(/\/tasks\/tsk_[^/]+$/)

  const { items } = await tasksClient(stack.url).listTasks({ projectId: workspace.projectId, includeArchived: true })
  const created = items.find((item) => item.title === "Ship the form")
  expect(created).toMatchObject({ status: "backlog" })
  const detail = await tasksClient(stack.url).getTask(created?.id ?? "")
  expect(detail.task.description).toBe("## Plan\n\nRich text")
  expect(detail.attachments.map((attachment) => attachment.filename)).toEqual(["keep.png"])
})
