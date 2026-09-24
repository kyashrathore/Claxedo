import fs from "node:fs/promises"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, gitFolder, sessionRoute, test, UI, type Stack } from "../harness"

type ProjectRecord = { id: string; name: string; directory?: string | null; repoUrl?: string | null }

async function serverProjects(url: string): Promise<ProjectRecord[]> {
  const response = await fetch(new URL("/api/claxedo/projects", url))
  expect(response.status).toBe(200)
  return ((await response.json()) as { projects: ProjectRecord[] }).projects
}

async function serverProject(url: string, id: string): Promise<{ status: number; project?: ProjectRecord }> {
  const response = await fetch(new URL(`/api/claxedo/projects/${encodeURIComponent(id)}`, url))
  if (response.status !== 200) return { status: response.status }
  return { status: 200, project: ((await response.json()) as { project: ProjectRecord }).project }
}

function railMenu(app: Page, project: string) {
  const header = app.getByRole("navigation", { name: UI.rail }).getByTestId("project-header").filter({ hasText: project })
  const show = async () => {
    const drawer = app.getByRole("button", { name: UI.openRail })
    if (await drawer.isVisible()) await drawer.click()
  }
  return {
    header,
    show,
    open: async () => {
      await show()
      await header.hover()
      await header.getByRole("button", { name: /^More options for / }).click()
    },
  }
}

function projectChip(app: Page) {
  return app.getByRole("button", { name: "Project", exact: true })
}

async function openCreatePanel(app: Page) {
  await projectChip(app).click()
  await expect(app.getByRole("textbox", { name: "Search projects" })).toBeFocused()
  await app.getByRole("button", { name: "Create project…" }).click()
}

async function createFolderProject(app: Page, typed: string, folder: string) {
  await openCreatePanel(app)
  await app.getByRole("button", { name: "Choose folder" }).click()
  const dialog = app.getByRole("dialog", { name: "New Project" })
  await dialog.getByRole("textbox", { name: "Search folders" }).fill(typed)
  await dialog.getByRole("button", { name: new RegExp(` ${folder} /$`) }).click()
  await expect(dialog).toHaveCount(0)
  await app.getByRole("button", { name: "Create project", exact: true }).click()
  await expect(projectChip(app)).toContainText(folder)
}

async function cloneProject(app: Page, url: string, name: string) {
  await openCreatePanel(app)
  await app.getByRole("button", { name: "Clone a repository instead" }).click()
  await app.getByRole("button", { name: "Paste a URL instead" }).click()
  await app.getByRole("textbox", { name: "Repository URL" }).fill(url)
  await app.getByRole("button", { name: "Create project", exact: true }).click()
  await expect(projectChip(app)).toContainText(name)
}

async function renameProject(stack: Stack, app: Page, id: string, from: string, to: string) {
  const edit = async () => {
    const dialog = app.getByRole("dialog", { name: "Edit project" })
    const field = dialog.getByRole("textbox", { name: "Name", exact: true })
    await expect(field).toHaveValue(from)
    await field.fill(to)
    await dialog.getByRole("button", { name: "Save" }).click()
    await expect(dialog).toHaveCount(0)
  }
  if (stack.app === "v1") {
    await railMenu(app, from).open()
    await app.getByRole("menuitem", { name: "Edit" }).click()
    await edit()
    await app.reload()
    await railMenu(app, to).show()
    await expect(railMenu(app, to).header).toBeVisible()
    return
  }
  await test.step("DECISIONS 17:26: a project is edited in Settings → Projects", async () => {
    await app.goto(`${stack.url}/settings/projects`)
    await app.getByRole("region", { name: "Projects" }).getByRole("link", { name: from, exact: true }).click()
    await expect(app).toHaveURL(`${stack.url}/settings/projects?project=${encodeURIComponent(id)}`)
    await app.getByRole("button", { name: "Edit", exact: true }).click()
    await edit()
    await expect(app.getByRole("heading", { level: 2, name: to })).toBeVisible()
  })
}

async function removeProject(stack: Stack, app: Page, id: string, name: string) {
  if (stack.app === "v1") {
    await railMenu(app, name).open()
    await app.getByRole("menuitem", { name: "Remove project" }).click()
    await expect(railMenu(app, name).header).toHaveCount(0)
    return
  }
  await test.step("DECISIONS 12: Remove asks first, then removes the project everywhere", async () => {
    await app.goto(`${stack.url}/settings/projects?project=${encodeURIComponent(id)}`)
    await app.getByRole("button", { name: "Remove", exact: true }).click()
    await app.getByRole("dialog", { name: "Remove project" }).getByRole("button", { name: "Remove", exact: true }).click()
    await expect(app).toHaveURL(/\/settings\/projects$/)
    await expect(app.getByRole("region", { name: "Projects" }).getByRole("link", { name, exact: true })).toHaveCount(0)
    expect((await serverProject(stack.url, id)).status).toBe(404)
  })
}

test("02 projects, local: create a folder and a clone from the Project chip, edit, remove, each read back by id", async ({ stack, page: app }) => {
  const existing = await stack.daemon.makeWorkspace("existing")
  const alphaFolder = await gitFolder(path.join(stack.dataDir, "folders"), "alpha")
  const remote = await stack.gitRemote("beta")
  await app.goto(`${stack.url}${sessionRoute(existing.id)}`)
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  await expect(projectChip(app)).toContainText(path.basename(existing.directory))

  await createFolderProject(app, "~/folders/alpha", "alpha")
  const alpha = (await serverProjects(stack.url)).find((project) => project.name === "alpha")
  expect(await fs.realpath(alpha?.directory ?? "")).toBe(alphaFolder)
  const alphaId = alpha?.id ?? ""

  await cloneProject(app, remote.url, "beta")
  const beta = (await serverProjects(stack.url)).find((project) => project.repoUrl === remote.url)
  expect(beta?.name).toBe("beta")
  expect(await fs.readFile(path.join(beta?.directory ?? "", "README.md"), "utf8")).toBe("beta-source\n")

  await projectChip(app).click()
  await app.getByRole("textbox", { name: "Search projects" }).fill("alpha")
  await app.keyboard.press("Enter")
  await expect(projectChip(app)).toContainText("alpha")

  await renameProject(stack, app, alphaId, "alpha", "Alpha renamed")
  expect((await serverProject(stack.url, alphaId)).project?.name).toBe("Alpha renamed")

  await removeProject(stack, app, alphaId, "Alpha renamed")
  expect(await fs.readFile(path.join(alphaFolder, "README.md"), "utf8")).toBe("alpha\n")
})
