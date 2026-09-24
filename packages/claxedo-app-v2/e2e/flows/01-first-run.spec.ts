import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import type { Locator, Page } from "@playwright/test"
import { assistantText, expect, installedCli, test } from "../harness"

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

async function onboardV2(app: Page, folder: string): Promise<Locator> {
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
  return app.getByRole("textbox", { name: "Prompt" })
}

async function onboardV1(app: Page, fromHome: string): Promise<Locator> {
  await expect(app.getByRole("heading", { level: 1, name: "Start with a project" })).toBeVisible()
  await app.getByRole("button", { name: "Choose folder" }).click()
  await app.getByRole("textbox", { name: "Search folders" }).fill(fromHome)
  await app.getByRole("dialog", { name: "New Project" }).getByRole("button", { name: /first/ }).click()
  await app.getByRole("button", { name: "Continue" }).click()
  await expect(app.getByRole("heading", { level: 1, name: "Connect an AI" })).toBeVisible()
  await expect(app.getByRole("radiogroup", { name: "Claude Code" })).toBeVisible()
  await app.getByRole("button", { name: "Next", exact: true }).click()
  await expect(app.getByRole("radiogroup", { name: "Where work runs" }).getByRole("radio", { name: /^Just this machine/ })).toBeChecked()
  expect(await pageOverflows(app)).toBe(false)
  await app.getByRole("button", { name: "Open project" }).click()
  return app.getByRole("textbox", { name: /^Ask anything/ })
}

test("01 first run: onboarding detects the agents, adds a folder project, and the first prompt runs", async ({ stack, api, app }) => {
  if (stack.app === "v1") {
    const claude = await installedCli("claude")
    test.skip(!claude.available, claude.available ? "" : claude.reason)
  }
  const folder = await gitFolder(path.join(stack.dataDir, "folders"), "first")
  const prompt = stack.app === "v2" ? await onboardV2(app, folder) : await onboardV1(app, path.join("folders", "first"))
  await prompt.click()
  await prompt.pressSequentially(`Reply with exactly this one token: ${MARKER}`)
  await expect(app.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
  await prompt.press("Enter")
  await expect(app.getByText(MARKER, { exact: true })).toBeVisible()

  const projects = await serverProjects(stack.url)
  expect(projects.map((project) => project.directory)).toEqual([folder])
  if (stack.app === "v2") expect(projects[0]?.name).toBe("First project")
  const sessions = await api.sessions(folder)
  expect(sessions).toHaveLength(1)
  expect(assistantText(await api.messages(folder, sessions[0]?.id ?? ""))).toContain(MARKER)
})
