import fs from "node:fs/promises"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, gitFolder, test } from "../harness"

const SESSION_URL = /\/w\/[^/]+\/s\/[^/?]+$/

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

async function finishAddOnThisMachine(app: Page) {
  await app.getByRole("button", { name: "Next", exact: true }).click()
  await app.getByRole("button", { name: "Skip for now" }).click()
  await expect(app.getByRole("radiogroup", { name: "Where the work runs" }).getByRole("radio", { name: /^This machine/ })).toBeChecked()
  await app.getByRole("button", { name: "Create project" }).click()
  await expect(app).toHaveURL(SESSION_URL)
}

async function projectsList(app: Page) {
  const list = app.getByRole("region", { name: "Projects" })
  const menu = app.getByRole("button", { name: "Open menu" })
  await expect(list.or(menu).first()).toBeVisible()
  if (await menu.isVisible()) await menu.click()
  return list
}

async function chooseFolder(app: Page, typed: string, name: string) {
  await app.getByRole("button", { name: "Browse" }).click()
  const dialog = app.getByRole("dialog", { name: "New Project" })
  await dialog.getByRole("textbox", { name: "Search folders" }).fill(typed)
  await dialog.getByRole("button", { name: new RegExp(` ${name} /$`) }).click()
  await expect(dialog).toHaveCount(0)
}

async function addFolderProject(app: Page, name: string, fromHome: string) {
  await (await projectsList(app)).getByRole("button", { name: "New project" }).click()
  await app.getByRole("textbox", { name: "Name", exact: true }).fill(name)
  await app.getByRole("button", { name: "Folder on this machine" }).click()
  await chooseFolder(app, `~/${fromHome}`, path.basename(fromHome))
  await finishAddOnThisMachine(app)
}

async function cloneProject(app: Page, url: string) {
  await (await projectsList(app)).getByRole("button", { name: "New project" }).click()
  await app.getByRole("textbox", { name: "Repository URL" }).fill(url)
  await finishAddOnThisMachine(app)
}

async function renameOnProjectPage(app: Page, from: string, to: string) {
  await expect(app.getByRole("heading", { level: 1, name: from })).toBeVisible()
  await app.getByRole("button", { name: "Rename", exact: true }).click()
  const dialog = app.getByRole("dialog", { name: "Rename project" })
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(to)
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(app.getByRole("heading", { level: 1, name: to })).toBeVisible()
}

async function removeOnProjectPage(app: Page, name: string) {
  await app.getByRole("button", { name: "Remove", exact: true }).click()
  await app.getByRole("dialog", { name: "Remove project" }).getByRole("button", { name: "Remove", exact: true }).click()
  await expect((await projectsList(app)).getByRole("button", { name, exact: true })).toHaveCount(0)
}

test("02 projects, local: add a folder and a clone, rename, remove, each read back by id", async ({ stack, api, page: app }) => {
  const root = path.join(stack.dataDir, "folders")
  await api.createProject("Existing", await gitFolder(root, "existing"))
  const alphaFolder = await gitFolder(root, "alpha")
  const remote = await stack.gitRemote("beta")
  await app.goto(`${stack.url}/`)
  await addFolderProject(app, "Alpha", "folders/alpha")
  await app.goto(`${stack.url}/`)
  await expect((await projectsList(app)).getByRole("button", { name: "Existing", exact: true })).toBeVisible()
  const alpha = (await serverProjects(stack.url)).find((project) => project.name === "Alpha")
  expect(await fs.realpath(alpha?.directory ?? "")).toBe(alphaFolder)
  const alphaId = alpha?.id ?? ""

  await app.goto(`${stack.url}/p/${encodeURIComponent(alphaId)}`)
  await renameOnProjectPage(app, "Alpha", "Alpha renamed")
  expect((await serverProject(stack.url, alphaId)).project?.name).toBe("Alpha renamed")
  await app.getByRole("button", { name: "Open", exact: true }).click()
  await expect(app.getByRole("region", { name: "New session" })).toBeVisible()
  expect(await api.sessions(alpha?.directory ?? "")).toHaveLength(1)

  await app.goto(`${stack.url}/`)
  await cloneProject(app, remote.url)
  const beta = (await serverProjects(stack.url)).find((project) => project.repoUrl === remote.url)
  expect(beta?.name).toBe("beta")
  expect(await fs.readFile(path.join(beta?.directory ?? "", "README.md"), "utf8")).toBe("beta-source\n")

  await app.goto(`${stack.url}/`)
  await (await projectsList(app)).getByRole("button", { name: "Alpha renamed", exact: true }).click()
  await expect(app).toHaveURL(new RegExp(`/p/${encodeURIComponent(alphaId)}$`))
  await removeOnProjectPage(app, "Alpha renamed")
  expect((await serverProject(stack.url, alphaId)).status).toBe(404)
  expect(await fs.readFile(path.join(alphaFolder, "README.md"), "utf8")).toBe("alpha\n")
})
