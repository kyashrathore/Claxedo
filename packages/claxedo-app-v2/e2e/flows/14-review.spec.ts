import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import type { Locator, Page } from "@playwright/test"
import { acpScriptToken, expect, SCRIPTED_ACP_HARNESS, test } from "../harness"

const execFileAsync = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const env = { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined }
  const identity = ["-c", "user.email=e2e@claxedo.test", "-c", "user.name=e2e"]
  const { stdout } = await execFileAsync("git", [...identity, ...args], { cwd, env })
  return stdout.trim()
}

async function createServerProject(url: string, name: string, directory: string) {
  const response = await fetch(new URL("/api/claxedo/projects", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, source: { kind: "directory", directory } }),
  })
  expect(response.status).toBe(201)
}

async function openPanelTab(app: Page, name: string): Promise<Locator> {
  const toggle = app.getByRole("button", { name: "Toggle workspace panel" })
  await expect(toggle).toBeVisible()
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
  await app.getByRole("tablist", { name: "Workspace panel tabs" }).getByRole("tab", { name }).click()
  return app.getByRole("tabpanel", { name })
}

async function commentOnLine(changes: Locator, line: string, comment: string) {
  await changes.getByText(line).hover()
  await changes.getByRole("button", { name: "Comment on this line" }).click()
  await changes.getByRole("textbox", { name: "Add comment" }).fill(comment)
  await changes.getByRole("button", { name: "Comment", exact: true }).click()
}

test("14 review: diff, line comment, commit, push to a bare remote, worktree, the comment reaches the agent", async ({
  stack,
  api,
  app,
}) => {
  const workspace = await stack.daemon.makeWorkspace("review")
  const remote = path.join(stack.dataDir, "remote.git")
  await git(stack.dataDir, "init", "-q", "--bare", remote)
  await git(workspace.directory, "remote", "add", "origin", remote)
  await fs.appendFile(path.join(workspace.directory, "README.md"), "a reviewed line\n")
  await createServerProject(stack.url, "Review", workspace.directory)
  await stack.acp.write("answer", { steps: [{ kind: "text", text: "Read your line comment." }] })
  const session = await api.createSession(workspace.directory, { title: "Review", harness: SCRIPTED_ACP_HARNESS })

  await app.goto(`${stack.url}/w/${encodeURIComponent(workspace.id)}/s/${encodeURIComponent(session.id)}`)
  const changes = await openPanelTab(app, "Changes")
  await changes.getByRole("button", { name: "Toggle diff for README.md" }).click()
  await commentOnLine(changes, "a reviewed line", "Why was this line added?")
  await expect(changes.getByText("Comment on line 2")).toBeVisible()

  const commit = changes.getByRole("region", { name: "Commit" })
  await commit.getByRole("textbox", { name: "Commit message" }).fill("Add a reviewed line")
  await commit.getByRole("button", { name: "Commit", exact: true }).click()
  await expect(commit.getByText(/^Committed [0-9a-f]{7}$/)).toBeVisible()
  expect(await git(workspace.directory, "log", "-1", "--format=%s")).toBe("Add a reviewed line")

  await commit.getByRole("button", { name: "Publish Branch" }).click()
  await expect(commit.getByText("Pushed to origin/main")).toBeVisible()
  expect(await git(remote, "log", "-1", "--format=%s", "main")).toBe("Add a reviewed line")

  await changes.getByRole("button", { name: /^Worktrees/ }).click()
  const worktrees = changes.getByRole("region", { name: "Worktrees" })
  await worktrees.getByRole("textbox", { name: "Name" }).fill("feature")
  await worktrees.getByRole("button", { name: "Create worktree" }).click()
  await expect(worktrees.getByText(/^Created /)).toBeVisible()
  expect(await git(workspace.directory, "worktree", "list")).toContain("feature")

  await expect(changes.getByText("No changes")).toBeVisible()
  await expect(changes.getByText("Up to date")).toBeVisible()

  const prompt = app.getByRole("textbox", { name: "Prompt" })
  await expect(app.getByRole("region", { name: "Session" }).getByText("Why was this line added?")).toBeVisible()
  await prompt.fill(`Answer my review comment. ${acpScriptToken("answer")}`)
  await prompt.press("Enter")
  await expect(app.getByText("Read your line comment.")).toBeVisible()
  expect(JSON.stringify(await api.messages(workspace.directory, session.id))).toContain("Why was this line added?")
})
