import { expect, test } from "../harness"

test("18 a task is created from Tasks in a drawer at the right edge and read back from the server", async ({ stack, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("tasks", "Tasks project")
  await app.goto(`${stack.url}/tasks`)
  await app.getByRole("button", { name: "New task", exact: true }).first().click()

  const drawer = app.getByRole("dialog", { name: "New task" })
  const box = await drawer.boundingBox()
  const viewport = app.viewportSize()
  if (!box || !viewport) throw new Error("The new task drawer is not laid out")
  expect(box.x + box.width).toBeCloseTo(viewport.width, 0)
  if (isMobile) expect(box.width).toBeCloseTo(viewport.width, 0)
  const create = drawer.getByRole("button", { name: "Create", exact: true })
  await expect(create).toBeDisabled()

  await drawer.getByRole("textbox", { name: "Task title" }).fill("Ship the drawer")
  await expect(create).toBeEnabled()
  await create.click()
  await expect(drawer).toHaveCount(0)

  const listed = await fetch(`${stack.url}/api/claxedo/tasks/tasks?projectId=${encodeURIComponent(workspace.projectId)}`)
  expect(listed.status).toBe(200)
  expect(JSON.stringify(await listed.json())).toContain("Ship the drawer")
})
