import fs from "node:fs/promises"
import path from "node:path"
import type { Locator } from "@playwright/test"
import { acpScriptToken, expect, git, SCRIPTED_ACP_HARNESS, sendPrompt, sessionRoute, test, UI } from "../harness"

async function commentOnLine(panel: Locator, line: string, comment: string) {
  const gutter = panel.getByRole("button", { name: "Comment", exact: true }).first()
  await expect(async () => {
    await panel.getByText(line).first().hover()
    await expect(gutter).toBeVisible({ timeout: 1_000 })
  }).toPass()
  await gutter.click()
  await panel.getByRole("textbox", { name: "Add comment" }).fill(comment)
  await panel.getByRole("button", { name: "Comment", exact: true }).last().click()
}

function lastSubject(directory: string, ref = "HEAD") {
  return git(directory, "log", "-1", "--format=%s", ref).then(
    (subject) => subject.trim(),
    (error: Error) => error.message,
  )
}

test.skip(({ isMobile }) => isMobile, "flow 14 runs at desktop width")

test("14 review: diff, line comment, commit, push to a bare remote, the comment reaches the agent", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("review")
  const remote = path.join(stack.dataDir, "remote.git")
  await git(stack.dataDir, "init", "-q", "--bare", remote)
  await git(workspace.directory, "remote", "add", "origin", remote)
  await fs.appendFile(path.join(workspace.directory, "README.md"), "a reviewed line\n")
  await stack.acp.write("answer", { steps: [{ kind: "text", text: "Read your line comment." }] })
  const session = await api.createSession(workspace.directory, { title: "Review", harness: SCRIPTED_ACP_HARNESS })

  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
  await app.getByRole("button", { name: "Open changes" }).click()
  const panel = app.getByRole("complementary", { name: "Workspace panel" })
  await panel.getByRole("button", { name: "Toggle diff for README.md" }).click()
  await commentOnLine(panel, "a reviewed line", "Why was this line added?")
  await expect(panel.getByText("Why was this line added?")).toBeVisible()

  await panel.getByRole("button", { name: "Stage all" }).click()
  await expect(panel.getByRole("button", { name: "Staged changes (1)" })).toBeVisible()
  await panel.getByRole("textbox", { name: "Message (⌘⏎ to commit)" }).fill("Add a reviewed line")
  await panel.getByRole("button", { name: "Commit", exact: true }).click()
  await expect(panel.getByRole("button", { name: "Staged changes (0)" })).toBeVisible()
  await expect(panel.getByText("No changes", { exact: true })).toBeVisible()
  await expect.poll(() => lastSubject(workspace.directory)).toBe("Add a reviewed line")

  await panel.getByRole("button", { name: "Publish Branch" }).click()
  await expect.poll(() => lastSubject(remote, "main")).toBe("Add a reviewed line")

  await sendPrompt(app, `Answer my review comment. ${acpScriptToken("answer")}`)
  await expect(app.getByText("Read your line comment.")).toBeVisible()
  expect(JSON.stringify(await api.messages(workspace.directory, session.id))).toContain("Why was this line added?")
})
