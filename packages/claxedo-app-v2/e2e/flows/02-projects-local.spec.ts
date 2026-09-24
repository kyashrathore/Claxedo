import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { promisify } from "node:util"
import type { Page } from "@playwright/test"
import { expect, test } from "../harness"

const execFileAsync = promisify(execFile)
const LANE_PORTS = { first: 47300, last: 47399 }
const SESSION_URL = /\/w\/[^/]+\/s\/[^/?]+$/

type ProjectRecord = { id: string; name: string; directory?: string | null; repoUrl?: string | null }

async function git(cwd: string, ...args: string[]) {
  const env = { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined }
  await execFileAsync("git", ["-c", "user.email=e2e@claxedo.test", "-c", "user.name=e2e", ...args], { cwd, env })
}

async function gitFolder(root: string, name: string): Promise<string> {
  const directory = path.join(root, name)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, "README.md"), `${name}\n`)
  await git(directory, "init", "-q")
  await git(directory, "add", "README.md")
  await git(directory, "commit", "-q", "-m", "init")
  return fs.realpath(directory)
}

async function listenInLaneRange(server: http.Server): Promise<number> {
  for (let port = LANE_PORTS.first; port <= LANE_PORTS.last; port += 1) {
    const bound = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false))
      server.listen(port, "127.0.0.1", () => resolve(true))
    })
    if (bound) return port
  }
  throw new Error(`No free port in ${LANE_PORTS.first}-${LANE_PORTS.last}`)
}

async function gitRemote(root: string, name: string) {
  const source = await gitFolder(root, `${name}-source`)
  const served = path.join(root, "served")
  const bare = path.join(served, `${name}.git`)
  await git(root, "clone", "-q", "--bare", source, bare)
  await git(bare, "update-server-info")
  const server = http.createServer((request, response) => {
    const requested = decodeURIComponent(new URL(request.url ?? "/", "http://remote").pathname)
    const file = path.join(served, path.normalize(requested))
    if (!file.startsWith(served + path.sep)) return void response.writeHead(404).end()
    void fs.readFile(file).then(
      (body) => response.writeHead(200).end(body),
      () => response.writeHead(404).end(),
    )
  })
  const port = await listenInLaneRange(server)
  return {
    url: `http://127.0.0.1:${port}/${name}.git`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

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

async function createServerProject(url: string, name: string, directory: string) {
  const response = await fetch(new URL("/api/claxedo/projects", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, source: { kind: "directory", directory } }),
  })
  expect(response.status).toBe(201)
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

async function addFolderProject(app: Page, name: string, folder: string) {
  await (await projectsList(app)).getByRole("button", { name: "New project" }).click()
  await app.getByRole("textbox", { name: "Name", exact: true }).fill(name)
  await app.getByRole("button", { name: "Folder on this machine" }).click()
  await app.getByRole("textbox", { name: "Folder", exact: true }).fill(folder)
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

test("02 projects, local: add a folder and a clone, rename, remove, each read back by id", async ({ stack, page: app }) => {
  const root = path.join(stack.dataDir, "folders")
  await createServerProject(stack.url, "Existing", await gitFolder(root, "existing"))
  const alphaFolder = await gitFolder(root, "alpha")
  const remote = await gitRemote(root, "beta")
  try {
    await app.goto(`${stack.url}/`)
    await addFolderProject(app, "Alpha", alphaFolder)
    await app.goto(`${stack.url}/`)
    await expect((await projectsList(app)).getByRole("button", { name: "Existing", exact: true })).toBeVisible()
    const alpha = (await serverProjects(stack.url)).find((project) => project.directory === alphaFolder)
    expect(alpha?.name).toBe("Alpha")
    const alphaId = alpha?.id ?? ""

    await app.goto(`${stack.url}/p/${encodeURIComponent(alphaId)}`)
    await renameOnProjectPage(app, "Alpha", "Alpha renamed")
    expect((await serverProject(stack.url, alphaId)).project?.name).toBe("Alpha renamed")

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
  } finally {
    await remote.close()
  }
})
