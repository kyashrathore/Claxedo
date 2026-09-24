import fs from "node:fs/promises"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, gitFolder, test } from "../harness"

const SESSION_URL = /\/w\/[^/]+\/session\/[^/?]+$/

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

async function chooseFolder(app: Page, typed: string, name: string) {
  await app.getByRole("button", { name: "Browse" }).click()
  const dialog = app.getByRole("dialog", { name: "New Project" })
  await dialog.getByRole("textbox", { name: "Search folders" }).fill(typed)
  await dialog.getByRole("button", { name: new RegExp(` ${name} /$`) }).click()
  await expect(dialog).toHaveCount(0)
}

async function addFolderProject(app: Page, url: string, name: string, fromHome: string) {
  await app.goto(`${url}/projects/new`)
  await app.getByRole("textbox", { name: "Name", exact: true }).fill(name)
  await app.getByRole("button", { name: "Folder on this machine" }).click()
  await chooseFolder(app, `~/${fromHome}`, path.basename(fromHome))
  await finishAddOnThisMachine(app)
}

async function cloneProject(app: Page, url: string, repoUrl: string) {
  await app.goto(`${url}/projects/new`)
  await app.getByRole("textbox", { name: "Repository URL" }).fill(repoUrl)
  await finishAddOnThisMachine(app)
}

function projectLink(app: Page, name: string) {
  return app.getByRole("region", { name: "Projects" }).getByRole("link", { name, exact: true })
}

async function editName(app: Page, from: string, to: string) {
  await app.getByRole("button", { name: "Edit", exact: true }).click()
  const dialog = app.getByRole("dialog", { name: "Edit project" })
  const field = dialog.getByRole("textbox", { name: "Name", exact: true })
  await expect(field).toHaveValue(from)
  await field.fill(to)
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(dialog).toHaveCount(0)
  await expect(app.getByRole("heading", { level: 2, name: to })).toBeVisible()
}

async function removeProject(app: Page, name: string) {
  await app.getByRole("button", { name: "Remove", exact: true }).click()
  await app.getByRole("dialog", { name: "Remove project" }).getByRole("button", { name: "Remove", exact: true }).click()
  await expect(app).toHaveURL(/\/settings\/projects$/)
  await expect(projectLink(app, "Existing")).toBeVisible()
  await expect(projectLink(app, name)).toHaveCount(0)
}

test("02 projects, local: add a folder and a clone, edit, remove, each read back by id", async ({ stack, api, page: app }) => {
  const root = path.join(stack.dataDir, "folders")
  await api.createProject("Existing", await gitFolder(root, "existing"))
  const alphaFolder = await gitFolder(root, "alpha")
  const remote = await stack.gitRemote("beta")
  await addFolderProject(app, stack.url, "Alpha", "folders/alpha")
  const alpha = (await serverProjects(stack.url)).find((project) => project.name === "Alpha")
  expect(await fs.realpath(alpha?.directory ?? "")).toBe(alphaFolder)
  const alphaId = alpha?.id ?? ""

  await app.goto(`${stack.url}/settings/projects`)
  await expect(projectLink(app, "Existing")).toBeVisible()
  await projectLink(app, "Alpha").click()
  await expect(app).toHaveURL(`${stack.url}/settings/projects?project=${encodeURIComponent(alphaId)}`)
  await editName(app, "Alpha", "Alpha renamed")
  expect((await serverProject(stack.url, alphaId)).project?.name).toBe("Alpha renamed")
  await app.getByRole("button", { name: "Open", exact: true }).click()
  await expect(app.getByRole("region", { name: "New session" })).toBeVisible()
  expect(await api.sessions(alpha?.directory ?? "")).toHaveLength(1)

  await cloneProject(app, stack.url, remote.url)
  const beta = (await serverProjects(stack.url)).find((project) => project.repoUrl === remote.url)
  expect(beta?.name).toBe("beta")
  expect(await fs.readFile(path.join(beta?.directory ?? "", "README.md"), "utf8")).toBe("beta-source\n")
  await app.goto(`${stack.url}/settings/projects`)
  await expect(projectLink(app, "beta")).toBeVisible()

  await app.goto(`${stack.url}/settings/projects?project=${encodeURIComponent(alphaId)}`)
  await expect(app.getByRole("heading", { level: 2, name: "Alpha renamed" })).toBeVisible()
  await removeProject(app, "Alpha renamed")
  expect((await serverProject(stack.url, alphaId)).status).toBe(404)
  expect(await fs.readFile(path.join(alphaFolder, "README.md"), "utf8")).toBe("alpha\n")
})
