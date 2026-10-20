import { pluginSurface, tasksClient } from "../harness/tasks"
import { expect, test } from "../harness"

const SWATCH = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGNQTX5NEmIY1TCqYfhqAAB2SXMQ7mVTQgAAAABJRU5ErkJggg=="

test("18 a task is created from the Tasks page's form of labelled fields and read back from the server", async ({ stack, app }) => {
  const workspace = await stack.daemon.makeWorkspace("tasks", "Tasks project")
  await app.goto(`${stack.url}/tasks`)
  const surface = pluginSurface(app)
  await surface.getByRole("button", { name: "New task", exact: true }).click()

  const form = surface.getByRole("region", { name: "New task" })
  const fields = [
    form.getByRole("textbox", { name: "Title", exact: true }),
    form.getByRole("textbox", { name: "Description", exact: true }),
    form.getByRole("combobox", { name: "Project", exact: true }),
    form.getByRole("group", { name: "Status", exact: true }).getByRole("button", { name: "Status To do", exact: true }),
    form.getByRole("group", { name: "Images", exact: true }),
  ]
  for (const field of fields) await expect(field).toBeVisible()
  const tops = await Promise.all(fields.map(async (field) => (await field.boundingBox())?.y ?? Number.NaN))
  expect(tops[0]).toBeLessThan(tops[1] ?? Number.NaN)
  expect(tops[1]).toBeLessThan(tops[2] ?? Number.NaN)
  expect(tops[2]).toBeLessThanOrEqual(tops[3] ?? Number.NaN)
  expect(tops[3]).toBeLessThan(tops[4] ?? Number.NaN)
  await expect(form.getByText("PNG, JPEG, GIF or WebP, up to 6. Paste them anywhere in this form.", { exact: true })).toBeVisible()

  await form.getByRole("group", { name: "Images" }).locator('input[type="file"]').setInputFiles([
    { name: "keep.png", mimeType: "image/png", buffer: Buffer.from(SWATCH, "base64") },
    { name: "drop.png", mimeType: "image/png", buffer: Buffer.from(SWATCH, "base64") },
  ])
  await expect(form.getByRole("img", { name: "drop.png" })).toBeVisible()
  await form.getByText("drop.png", { exact: true }).hover()
  await form.getByRole("button", { name: "Remove drop.png", exact: true }).click()
  await expect(form.getByRole("img", { name: "drop.png" })).toHaveCount(0)
  await expect(form.getByRole("img", { name: "keep.png" })).toBeVisible()

  await fields[3]?.click()
  await app.getByRole("option", { name: "Backlog", exact: true }).click()
  await fields[0]?.fill("Ship the form")
  await fields[1]?.fill("Labelled fields")
  await form.getByRole("button", { name: "Create task", exact: true }).click()
  await expect(form).toHaveCount(0)
  await expect(app).toHaveURL(/\/tasks\/tsk_[^/]+$/)

  const { items } = await tasksClient(stack.url).listTasks({ projectId: workspace.projectId, includeArchived: true })
  const created = items.find((item) => item.title === "Ship the form")
  expect(created).toMatchObject({ status: "backlog" })
  const detail = await tasksClient(stack.url).getTask(created?.id ?? "")
  expect(detail.task.description).toBe("Labelled fields")
  expect(detail.attachments.map((attachment) => attachment.filename)).toEqual(["keep.png"])
})
