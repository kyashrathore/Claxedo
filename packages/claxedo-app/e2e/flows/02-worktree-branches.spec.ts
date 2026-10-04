import fs from "node:fs/promises"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, git, sendPrompt, sessionRoute, test, UI, SCRIPTED_ACP_CONNECTION_ID } from "../harness"

async function chooseWorkspace(app: Page, name: string) {
  await app.getByRole("button", { name: "Where it runs", exact: true }).click()
  await app.getByRole("textbox", { name: "Search where it runs" }).fill(name)
  await app.keyboard.press("Enter")
}

async function chooseBase(app: Page, name: string) {
  await app.getByRole("button", { name: "Base branch", exact: true }).click()
  await app.getByRole("textbox", { name: "Search branches" }).fill(name)
  await app.keyboard.press("Enter")
}

async function chooseScriptedHarness(app: Page) {
  await app.getByRole("button", { name: /^Select harness and model/ }).click()
  const picker = app.getByRole("dialog", { name: "Select harness, model and effort" })
  if (!(await picker.getByText(/Scripted ACP/).first().isVisible())) await picker.getByRole("button", { name: /^Harness/ }).click()
  await picker.getByText(/Scripted ACP/).first().click()
  await app.keyboard.press("Escape")
}

test("02 a refused session keeps the created worktree for retry", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("refused-worktree")
  await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)
  await app.getByRole("button", { name: "Where it runs", exact: true }).click()
  await app.getByRole("button", { name: /^New worktree on / }).click()
  await chooseScriptedHarness(app)
  const removed = await fetch(`${stack.url}/api/claxedo/agent-config/connections/${SCRIPTED_ACP_CONNECTION_ID}`, { method: "DELETE" })
  expect(removed.status).toBe(200)
  let creations = 0
  app.on("request", (request) => {
    if (request.url().includes("/experimental/worktree") && request.method() === "POST") creations += 1
  })
  const creation = app.waitForResponse((response) => response.url().includes("/experimental/worktree") && response.request().method() === "POST")
  await sendPrompt(app, "Keep the created worktree")
  const response = await creation
  expect(response.status()).toBe(200)
  const created = await response.json() as { name: string; branch: string; directory: string }
  await expect(app.getByRole("textbox", { name: UI.composer })).toHaveText("Keep the created worktree")
  await expect(app.getByRole("button", { name: "Where it runs", exact: true })).toHaveText(created.name)
  await expect(app.getByRole("button", { name: "Current branch", exact: true })).toHaveText(created.branch)
  await expect(app.getByRole("button", { name: "Current branch", exact: true })).toBeDisabled()
  const refusal = app.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/session") && response.request().method() === "POST" && response.status() >= 400)
  await app.getByRole("button", { name: UI.send }).click()
  await refusal
  await expect(app.getByRole("textbox", { name: UI.composer })).toHaveText("Keep the created worktree")
  expect(creations).toBe(1)
  expect(await api.sessions(created.directory)).toHaveLength(0)
  expect(await api.sessions(workspace.directory)).toHaveLength(0)
})

test("02 existing worktrees show their own branch and dirty status with branch selection disabled", async ({ stack, app }, testInfo) => {
  const workspace = await stack.daemon.makeWorkspace("existing-branches")
  const response = await fetch(`${stack.url}/experimental/worktree?workspaceId=${workspace.id}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "existing" }),
  })
  expect(response.status).toBe(200)
  const created = await response.json() as { directory: string; branch: string }
  await fs.writeFile(path.join(created.directory, "untracked.txt"), "dirty worktree\n")
  await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)
  const branch = app.getByRole("button", { name: "Current branch", exact: true })
  await expect(branch).toHaveText("main")
  await expect(branch).toBeDisabled()
  await chooseWorkspace(app, "existing")
  await expect(branch).toHaveText(`Dirty · ${created.branch}`)
  await expect(branch).toBeDisabled()
  await app.screenshot({ path: testInfo.outputPath("existing-worktree.png") })
  await chooseWorkspace(app, "existing-branches")
  await expect(branch).toHaveText("main")
  const status = await fetch(`${stack.url}/api/wr/git/status?directory=${encodeURIComponent(created.directory)}`)
  expect(status.status).toBe(200)
  expect(await status.json()).toMatchObject({ branch: created.branch, unstaged: expect.arrayContaining([expect.objectContaining({ path: "untracked.txt" })]) })
  expect((await git(workspace.directory, "branch", "--show-current")).trim()).toBe("main")
})

test("02 a missing base branch leaves the draft and destination intact for a corrected retry", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("missing-base")
  await git(workspace.directory, "branch", "dev")
  await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)
  await app.getByRole("button", { name: "Where it runs", exact: true }).click()
  await app.getByRole("button", { name: /^New worktree on / }).click()
  await chooseBase(app, "dev")
  await chooseScriptedHarness(app)
  await git(workspace.directory, "branch", "-D", "dev")
  const failed = app.waitForResponse((response) => response.url().includes("/experimental/worktree") && response.status() === 400)
  await sendPrompt(app, "Retry the chosen base")
  await failed
  await expect(app.getByRole("textbox", { name: UI.composer })).toHaveText("Retry the chosen base")
  await expect(app.getByRole("button", { name: "Where it runs", exact: true })).toHaveText("New worktree")
  await expect(app.getByRole("button", { name: "Base branch", exact: true })).toHaveText("From dev")
  expect(await api.sessions(workspace.directory)).toHaveLength(0)
  await git(workspace.directory, "branch", "dev")
  const retried = app.waitForResponse((response) => response.url().includes("/experimental/worktree") && response.request().method() === "POST")
  await app.getByRole("button", { name: UI.send }).click()
  const response = await retried
  expect(response.status()).toBe(200)
  const created = await response.json() as { directory: string }
  await expect(app).toHaveURL(/\/w\/[^/]+\/session\/[^/?]+$/)
  expect(await api.sessions(created.directory)).toHaveLength(1)
  expect((await git(created.directory, "rev-parse", "HEAD")).trim()).toBe((await git(workspace.directory, "rev-parse", "dev")).trim())
})

test("02 a new worktree starts from the selected branch on first send and leaves dirty source files intact", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("base-branch")
  await git(workspace.directory, "switch", "-c", "dev")
  await fs.writeFile(path.join(workspace.directory, "README.md"), "dev commit\n")
  await git(workspace.directory, "commit", "-am", "dev")
  const expectedCommit = (await git(workspace.directory, "rev-parse", "HEAD")).trim()
  await git(workspace.directory, "switch", "main")
  await fs.writeFile(path.join(workspace.directory, "README.md"), "keep dirty main\n")
  await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)
  await expect(app.getByRole("button", { name: "Current branch", exact: true })).toHaveText("Dirty · main")
  await app.getByRole("button", { name: "Where it runs", exact: true }).click()
  await app.getByRole("button", { name: /^New worktree on / }).click()
  await chooseBase(app, "dev")
  await expect(app.getByRole("button", { name: "Base branch", exact: true })).toHaveText("From dev")
  await chooseWorkspace(app, "base-branch")
  await expect(app.getByRole("button", { name: "Current branch", exact: true })).toHaveText("Dirty · main")
  await app.getByRole("button", { name: "Where it runs", exact: true }).click()
  await app.getByRole("button", { name: /^New worktree on / }).click()
  await expect(app.getByRole("button", { name: "Base branch", exact: true })).toHaveText("From main")
  await chooseBase(app, "dev")
  await chooseScriptedHarness(app)
  const creation = app.waitForResponse((response) => response.url().includes("/experimental/worktree") && response.request().method() === "POST")
  await sendPrompt(app, "Start from dev")
  const createdResponse = await creation
  expect(createdResponse.status()).toBe(200)
  const created = await createdResponse.json() as { directory: string; branch: string }
  await expect(app).toHaveURL(/\/w\/[^/]+\/session\/[^/?]+$/)
  expect(app.url()).not.toContain(`/w/${workspace.id}/`)
  expect((await git(created.directory, "rev-parse", "HEAD")).trim()).toBe(expectedCommit)
  expect(await fs.readFile(path.join(created.directory, "README.md"), "utf8")).toBe("dev commit\n")
  expect(await api.sessions(created.directory)).toHaveLength(1)
  expect(await api.sessions(workspace.directory)).toHaveLength(0)
  expect((await git(workspace.directory, "branch", "--show-current")).trim()).toBe("main")
  expect(await fs.readFile(path.join(workspace.directory, "README.md"), "utf8")).toBe("keep dirty main\n")
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
})

test("02 a tag named like the root's branch moves neither the default base nor the listed branch choice", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("tag-clash")
  await git(workspace.directory, "tag", "dev")
  await git(workspace.directory, "switch", "-c", "dev")
  await fs.writeFile(path.join(workspace.directory, "README.md"), "dev branch\n")
  await git(workspace.directory, "commit", "-am", "dev")
  const branchCommit = (await git(workspace.directory, "rev-parse", "refs/heads/dev")).trim()
  const createFromDraft = async (prompt: string, base?: string) => {
    await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)
    await app.getByRole("button", { name: "Where it runs", exact: true }).click()
    await app.getByRole("button", { name: /^New worktree on / }).click()
    await expect(app.getByRole("button", { name: "Base branch", exact: true })).toHaveText("From dev")
    if (base) await chooseBase(app, base)
    await chooseScriptedHarness(app)
    const creation = app.waitForResponse((response) => response.url().includes("/experimental/worktree") && response.request().method() === "POST")
    await sendPrompt(app, prompt)
    const response = await creation
    expect(response.status()).toBe(200)
    await expect(app).toHaveURL(/\/w\/[^/]+\/session\/[^/?]+$/)
    return (await response.json() as { directory: string }).directory
  }
  const defaulted = await createFromDraft("Start from the current branch")
  expect((await git(defaulted, "rev-parse", "HEAD")).trim()).toBe(branchCommit)
  const chosen = await createFromDraft("Start from the listed branch", "heads/dev")
  expect((await git(chosen, "rev-parse", "HEAD")).trim()).toBe(branchCommit)
  expect(await api.sessions(chosen)).toHaveLength(1)
})
