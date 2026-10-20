import path from "node:path"
import type { Page } from "@playwright/test"
import { acpScriptToken, appPluginRow, expect, listLivePlugins, registerLivePlugin, SCRIPTED_ACP_HARNESS, sessionRoute, test, writeLivePlugin, type ClaxedoApi, type Stack } from "../harness"

type CreatedTask = { readonly id: string; readonly title: string }

async function createTask(stack: Stack, projectId: string, title: string): Promise<CreatedTask> {
  const response = await fetch(`${stack.url}/api/claxedo/tasks/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientRequestId: crypto.randomUUID(), command: { type: "task.create", input: { projectId, title, description: "", workspaceId: null, parentTaskId: null } } }),
  })
  expect(response.status, await response.clone().text()).toBe(200)
  const answer = (await response.json()) as { result?: { task?: CreatedTask } }
  const task = answer.result?.task
  if (!task) throw new Error(`task.create answered ${JSON.stringify(answer)}`)
  return task
}

async function sessionWithTaskCard(stack: Stack, api: ClaxedoApi, task: CreatedTask, directory: string) {
  const session = await api.createSession(directory, { title: "Built-in cards", harness: SCRIPTED_ACP_HARNESS })
  const result = { task: { id: task.id, key: "1", title: task.title, status: "doing" } }
  await stack.acp.write("built-in-cards", {
    steps: [
      { kind: "tool", tool: "other", title: `mcp__claxedo-mcp__task_create ${task.title}`, input: { title: task.title }, text: JSON.stringify(result) },
      { kind: "text", text: "Card drawn." },
    ],
  })
  await api.prompt(directory, session.id, `Built-in cards: go. ${acpScriptToken("built-in-cards")}`)
  return session
}

async function openTaskRow(app: Page, url: string) {
  await app.goto(url)
  await expect(app.getByText("Card drawn.")).toBeVisible()
  return app.locator('[data-component="claxedo-tool"][data-tool="task_create"]')
}

async function switchTasks(app: Page, stack: Stack, on: boolean) {
  await app.goto(`${stack.url}/settings/app-plugins`)
  const row = appPluginRow(app, "Tasks")
  await row.getByRole("switch", { name: "Tasks on" }).click({ force: true })
  await expect(row).toContainText(on ? "On" : "Off")
}

test("36 the built-in Tasks plugin runs without a daemon registry or an approval, draws task cards that link to the task, and switches off and on", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("built-in", "Built-in project")
  const taken = await writeLivePlugin(path.join(stack.dataDir, "plugins", "taken"), { id: "claxedo-tasks", name: "Taken", app: "export default {}\n" })
  await expect(registerLivePlugin(stack.url, taken), "a live plugin may not take the built-in plugin's id").rejects.toThrow("answered 409")
  expect((await listLivePlugins(stack.url)).plugins.map((plugin) => plugin.id), "the daemon's live registry").toEqual([])

  await app.goto(`${stack.url}/settings/app-plugins?safe-mode`)
  const row = appPluginRow(app, "Tasks")
  await expect(row).toContainText("Built in")
  await expect(row, "a built-in plugin safe mode keeps on").toContainText("On")
  await expect(app.getByRole("dialog")).toHaveCount(0)
  await expect(row.getByRole("button", { name: "Remove" })).toHaveCount(0)
  await row.getByRole("button", { name: "Details" }).click()
  await expect(row.getByText("Requires", { exact: true })).toBeVisible()
  await expect(row.getByText("Folder", { exact: true }), "a built-in plugin has no folder").toHaveCount(0)

  const task = await createTask(stack, workspace.projectId, "Ship the built-in plugin")
  const session = await sessionWithTaskCard(stack, api, task, workspace.directory)
  const url = `${stack.url}${sessionRoute(workspace.id, session.id)}`
  const card = await openTaskRow(app, url)
  const link = card.getByRole("link", { name: `#1 ${task.title}` })
  await expect(link, "the task link the plugin's card template draws").toHaveAttribute("href", `/tasks/${task.id}`)
  await expect(card.locator('[data-slot="claxedo-tool-status"]')).toHaveText("In progress")
  await link.click()
  await expect(app).toHaveURL(new RegExp(`/tasks/${task.id}$`))
  await expect(app.getByRole("textbox", { name: "Task title" }), "the task the link opened").toHaveValue(task.title)

  await switchTasks(app, stack, false)
  const generic = await openTaskRow(app, url)
  await expect(generic, "the generic row a task call draws while the plugin is off").toContainText("Task create")
  await expect(generic.getByRole("link", { name: `#1 ${task.title}` })).toHaveCount(0)

  await switchTasks(app, stack, true)
  await expect((await openTaskRow(app, url)).getByRole("link", { name: `#1 ${task.title}` })).toBeVisible()
})
