import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import type { Page } from "@playwright/test"
import { assistantText, expect, test } from "../harness"

const execFileAsync = promisify(execFile)
const SESSION_URL = /\/w\/[^/]+\/s\/[^/?]+$/
const MARKER = "FIRSTRUN1"

async function gitFolder(root: string, name: string): Promise<string> {
  const directory = path.join(root, name)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, "README.md"), `${name}\n`)
  const env = { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined }
  const git = (...args: string[]) =>
    execFileAsync("git", ["-c", "user.email=e2e@claxedo.test", "-c", "user.name=e2e", ...args], { cwd: directory, env })
  await git("init", "-q")
  await git("add", "README.md")
  await git("commit", "-q", "-m", "init")
  return fs.realpath(directory)
}

async function serverProjects(url: string): Promise<{ id: string; name: string; directory?: string | null }[]> {
  const response = await fetch(new URL("/api/claxedo/projects", url))
  expect(response.status).toBe(200)
  return ((await response.json()) as { projects: { id: string; name: string; directory?: string | null }[] }).projects
}

function pageOverflows(app: Page) {
  return app.evaluate(() => {
    const page = document.scrollingElement ?? document.documentElement
    return page.scrollHeight > window.innerHeight || page.scrollWidth > window.innerWidth
  })
}

test("01 first run: onboarding detects the agents, adds a folder project, and the first prompt runs", async ({ stack, api, app }) => {
  test.skip(stack.app === "v1", "the v1 path of this baseline flow is not written yet")
  const folder = await gitFolder(path.join(stack.dataDir, "folders"), "first")

  await expect(app).toHaveURL(/\/welcome$/)
  await expect(app.getByRole("heading", { level: 1, name: "Start with a project" })).toBeVisible()
  await app.getByRole("textbox", { name: "Name", exact: true }).fill("First project")
  await app.getByRole("button", { name: "Folder on this machine" }).click()
  await app.getByRole("textbox", { name: "Folder", exact: true }).fill(folder)
  await app.getByRole("button", { name: "Next", exact: true }).click()

  await expect(app.getByRole("heading", { level: 1, name: "Connect an AI" })).toBeVisible()
  const agents = app.getByRole("radiogroup", { name: "Which AI runs the work" })
  await expect(agents.getByRole("radio", { name: /^Pi/ })).toBeEnabled()
  await app.getByRole("button", { name: "Back", exact: true }).click()
  await expect(app.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("First project")
  await expect(app.getByRole("textbox", { name: "Folder", exact: true })).toHaveValue(folder)
  await app.getByRole("button", { name: "Next", exact: true }).click()
  await agents.getByText("Pi", { exact: true }).click()
  await expect(agents.getByRole("radio", { name: /^Pi/ })).toBeChecked()
  await app.getByRole("button", { name: "Next", exact: true }).click()

  await expect(app.getByRole("heading", { level: 1, name: "Where it runs" })).toBeVisible()
  await expect(app.getByRole("radiogroup", { name: "Where the work runs" }).getByRole("radio", { name: /^This machine/ })).toBeChecked()
  expect(await pageOverflows(app)).toBe(false)
  await app.getByRole("button", { name: "Create project" }).click()

  await expect(app).toHaveURL(SESSION_URL)
  const sessionId = decodeURIComponent(new URL(app.url()).pathname.split("/").at(-1) ?? "")
  const prompt = app.getByRole("textbox", { name: "Prompt" })
  await prompt.fill(`Reply with exactly this one token: ${MARKER}`)
  await prompt.press("Enter")
  await expect(app.getByText(MARKER, { exact: true })).toBeVisible()

  const projects = await serverProjects(stack.url)
  expect(projects.map((project) => [project.name, project.directory])).toEqual([["First project", folder]])
  expect(assistantText(await api.messages(folder, sessionId))).toContain(MARKER)
})
