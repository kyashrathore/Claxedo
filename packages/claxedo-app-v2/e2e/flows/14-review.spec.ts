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

async function openReview(app: Page): Promise<Locator> {
  await app.getByRole("button", { name: "Open workspace panel" }).click()
  const panel = app.getByRole("complementary", { name: "Workspace panel" })
  await expect(panel.getByRole("button", { name: "Review", exact: true })).toHaveAttribute("aria-current", "true")
  return panel
}

async function commentOnLine(review: Locator, line: string, comment: string) {
  const gutter = review.getByRole("button", { name: "Comment", exact: true })
  await expect(async () => {
    await review.getByText(line).hover()
    await expect(gutter).toBeVisible({ timeout: 1_000 })
  }).toPass()
  await gutter.click()
  const editor = review.getByRole("textbox", { name: "Add comment" })
  await editor.fill(comment)
  await editor.press("ControlOrMeta+Enter")
}

test.skip(({ isMobile }) => isMobile, "flow 14 runs at desktop width")

test("14 review: diff, line comment, stage, commit, push to a bare remote, the comment reaches the agent", async ({
  stack,
  api,
  app,
}) => {
  const workspace = await stack.daemon.makeWorkspace("review", "Review")
  const remote = path.join(stack.dataDir, "remote.git")
  await git(stack.dataDir, "init", "-q", "--bare", remote)
  await git(workspace.directory, "remote", "add", "origin", remote)
  await fs.appendFile(path.join(workspace.directory, "README.md"), "a reviewed line\n")
  await stack.acp.write("answer", { steps: [{ kind: "text", text: "Read your line comment." }] })
  const session = await api.createSession(workspace.directory, { title: "Review", harness: SCRIPTED_ACP_HARNESS })

  await app.goto(`${stack.url}/w/${encodeURIComponent(workspace.id)}/s/${encodeURIComponent(session.id)}`)
  const panel = await openReview(app)
  await expect(panel.getByRole("button", { name: /^Uncommitted/ })).toBeVisible()
  await panel.getByRole("button", { name: "Toggle diff for README.md" }).click()
  await commentOnLine(panel, "a reviewed line", "Why was this line added?")
  await expect(panel.getByText("Comment on line 2")).toBeVisible()

  await panel.getByRole("button", { name: "Open Changes" }).click()
  const changes = panel.getByTestId("source-control-view")
  await changes.getByRole("button", { name: "Stage README.md" }).click()
  await expect(changes.getByTestId("source-control-group-staged")).toHaveAttribute("data-count", "1")
  await changes.getByRole("textbox", { name: "Message (⌘⏎ to commit)" }).fill("Add a reviewed line")
  await changes.getByRole("button", { name: "Commit", exact: true }).click()
  await expect(changes.getByText("No changes")).toBeVisible()
  expect(await git(workspace.directory, "log", "-1", "--format=%s")).toBe("Add a reviewed line")
  await expect(changes.getByRole("textbox", { name: "Message (⌘⏎ to commit)" })).toHaveValue("")

  await changes.getByRole("button", { name: "Publish Branch" }).click()
  await expect(changes.getByText("Up to date")).toBeVisible()
  expect(await git(remote, "log", "-1", "--format=%s", "main")).toBe("Add a reviewed line")

  const prompt = app.getByRole("textbox", { name: "Prompt" })
  await expect(
    app.getByRole("region", { name: "Review", exact: true }).getByText("Why was this line added?"),
  ).toBeVisible()
  await prompt.fill(`Answer my review comment. ${acpScriptToken("answer")}`)
  await prompt.press("Enter")
  await expect(app.getByText("Read your line comment.")).toBeVisible()
  expect(JSON.stringify(await api.messages(workspace.directory, session.id))).toContain("Why was this line added?")
})
